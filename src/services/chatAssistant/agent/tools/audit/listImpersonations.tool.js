import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { dayWindowBounds } from '../employees/common.js';
import {
  IMPERSONATION_ACCESS, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, NOT_CAPTURED, isoDay,
  auditScope, auditDeps, auditCountFacts, activityTier,
} from './common.js';

const MAX_NAME_MATCHES = 50;
const RESTRICTED = 'Restricted user';

/**
 * Name → user ids through queryUsers (the Users directory, so hidden accounts never resolve for a
 * non-platform-super viewer), minus platform-super accounts unless the viewer is one (people Ruling R12).
 * Ceiling: the first MAX_NAME_MATCHES matches only; a broader name narrows to those.
 */
async function idsForName(name, user, deps) {
  const filter = { search: name };
  if (!user.platformSuperUser) filter.platformSuperUser = { $ne: true };
  const page = await deps.queryUsers(filter, { limit: MAX_NAME_MATCHES, page: 1 }, user);
  return (page?.results || []).map((u) => String(u.id ?? u._id));
}

function displayName(u) {
  const name = u?.name != null ? String(u.name).trim() : '';
  const email = u?.email != null ? String(u.email).trim() : '';
  return name || email || null;
}

export default defineTool({
  name: 'list_impersonations',
  domain: 'audit',
  kind: 'read',
  description:
    'Impersonation ("Login as") history: which admin signed in as which user, when it started and ended. Use for ' +
    '"who impersonated Priya", "has anyone logged in as me", "impersonations last week", "is anyone ' +
    'impersonating right now". Newest first; total is the full count.',
  measure:
    'Impersonation SESSIONS (one per "Login as" start): everyone\'s with full Activity Logs access, otherwise ' +
      'only sessions you started (scope says which); endedAt is null ' +
      'when no end was recorded (still active, or the browser was closed without stopping).',
  input: Joi.object({
    filters: Joi.object({
      admin: Joi.string().min(1).max(100).description('Who impersonated: name or email (partial match).'),
      target: Joi.string().min(1).max(100).description('Who was impersonated: name or email (partial match).'),
      between: Joi.object({ from: isoDay, to: isoDay })
        .description('When the session started: inclusive whole days (IST).'),
      noEndRecorded: Joi.boolean()
        .description('true = only sessions with no recorded end ("impersonating right now").'),
    }),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  }),
  access: IMPERSONATION_ACCESS,
  async execute({ filters, limit = DEFAULT_LIST_LIMIT } = {}, ctx) {
    const user = auditScope(ctx);
    const deps = auditDeps(ctx);
    const f = filters || {};
    const empty = (notFound) => ({ total: 0, records: [], notFound, filtersApplied: f });

    const and = [];
    if (f.admin) {
      const ids = await idsForName(f.admin, user, deps);
      if (!ids.length) return empty('admin');
      and.push({ adminUser: { $in: ids } });
    }
    if (f.target) {
      const ids = await idsForName(f.target, user, deps);
      if (!ids.length) return empty('target');
      and.push({ impersonatedUser: { $in: ids } });
    }
    const { from, to } = dayWindowBounds(f.between);
    if (from || to) {
      and.push({ startedAt: { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) } });
    }
    if (f.noEndRecorded) and.push({ endedAt: null });

    // No page lists Impersonation rows; the history surfaces as impersonation.* rows on Activity Logs,
    // where a viewer below the see-everyone tier gets only rows they acted in. Same rule: own sessions.
    const tier = activityTier(user, deps);
    if (!tier.seesEveryone) and.push({ adminUser: tier.uid });

    // Same rule as the Activity Logs page: sessions by a directory-hidden admin are not listed, and a
    // hidden or platform-super target is labelled "Restricted user", for viewers who cannot see them.
    const seesHidden = deps.viewerSeesHiddenUsers(user);
    const hiddenIds = seesHidden ? [] : await deps.getDirectoryHiddenUserIds();
    if (hiddenIds.length) and.push({ adminUser: { $nin: hiddenIds } });
    const match = and.length ? { $and: and } : {};

    // No list service exists for Impersonation; select explicitly so adminRefreshToken never leaves Mongo.
    const [total, rows] = await Promise.all([
      deps.Impersonation.countDocuments(match),
      deps.Impersonation.find(match)
        .select('adminUser impersonatedUser startedAt endedAt')
        .sort('-startedAt')
        .limit(Math.min(limit, MAX_LIST_LIMIT))
        .lean(),
    ]);

    const userIds = [...new Set(rows.flatMap((r) => [r.adminUser, r.impersonatedUser]).filter(Boolean).map(String))];
    const people = userIds.length
      ? await deps.User.find({ _id: { $in: userIds } }).select('name email hideFromDirectory platformSuperUser').lean()
      : [];
    const hiddenSet = new Set(hiddenIds.map(String));
    const byId = new Map(people.map((u) => [String(u._id), u]));
    const label = (id, { maskPlatformSuper }) => {
      const u = id ? byId.get(String(id)) : null;
      if (!u) return null;
      if (!seesHidden && (hiddenSet.has(String(u._id)) || u.hideFromDirectory || (maskPlatformSuper && u.platformSuperUser))) {
        return RESTRICTED;
      }
      return displayName(u);
    };

    const records = rows.map((r) => {
      const endedAt = r.endedAt ?? null;
      const minutes = endedAt && r.startedAt ? Math.round((new Date(endedAt) - new Date(r.startedAt)) / 60000) : null;
      return {
        id: String(r._id),
        admin: label(r.adminUser, { maskPlatformSuper: false }),
        target: label(r.impersonatedUser, { maskPlatformSuper: true }),
        startedAt: r.startedAt ?? null,
        endedAt,
        durationMinutes: minutes,
      };
    });
    return {
      total,
      records,
      scope: tier.seesEveryone ? 'everyone' : 'only sessions you started',
      reason: NOT_CAPTURED,
      pagesViewed: NOT_CAPTURED,
      filtersApplied: f,
    };
  },
  render(result) {
    if (!result) return null;
    const facts = auditCountFacts('list_impersonations', 'impersonations', result.total ?? 0);
    if (!result.records?.length) return { blocks: [], facts };
    return {
      blocks: [{
        type: 'table',
        id: 'impersonations',
        tableType: 'impersonations',
        title: `Impersonations (${result.total})`,
        columns: [
          { key: 'admin', label: 'Admin', priority: 'primary' },
          { key: 'target', label: 'Signed in as', priority: 'primary' },
          { key: 'startedAt', label: 'Started', priority: 'primary', format: 'date' },
          { key: 'endedAt', label: 'Ended', priority: 'secondary', format: 'date' },
        ],
        rows: result.records.map((r) => ({
          admin: r.admin ?? '—',
          target: r.target ?? '—',
          startedAt: r.startedAt ?? null,
          endedAt: r.endedAt ?? null,
        })),
        layout: 'auto',
      }],
      facts,
    };
  },
});
