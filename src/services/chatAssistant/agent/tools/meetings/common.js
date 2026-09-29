import Joi from 'joi';
import { queryInternalMeetings as realQueryInternalMeetings } from '../../../../internalMeeting.service.js';
import { buildInternalMeetingsMongoFilter } from '../../../../../utils/internalMeetingQueryFilter.js';
import { dayRange } from '../employees/common.js';

// GET /internal-meetings is auth-only: internalMeetingScope is the real gate
// (all four meetings.* = every meeting; otherwise created / hosting / invited).
export const MEETINGS_ACCESS = Object.freeze({ note: 'internalMeeting.service internalMeetingScope (all or own/invited)' });
export const MAX_LIST_LIMIT = 50;
export const MEETING_STATUSES = ['scheduled', 'ended', 'cancelled'];

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.'); // format checked by dayRange

export const meetingFilters = Joi.object({
  search: Joi.string().min(1).max(200)
    .description('Free text matched against meeting title and host / invitee names — same as the Meetings page search box.'),
  status: Joi.string().valid(...MEETING_STATUSES)
    .description('Meeting lifecycle. Omit for every status.'),
  when: Joi.string().valid('upcoming', 'past', 'any').default('any')
    .description('upcoming = starts from now on; past = already started; any = both.'),
  scheduledBetween: Joi.object({ from: isoDay, to: isoDay })
    .description('Scheduled date window, inclusive whole days (IST).'),
  mine: Joi.boolean()
    .description('true = only meetings the viewer created, hosts or is invited to (the page\'s "Mine" toggle).'),
});

/** Fail closed without a user id: queryInternalMeetings skips the scope entirely when currentUser is null. */
export function meetingsScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('meeting tools need an authenticated user with an id');
  }
  return ctx.user;
}

export function meetingsDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    queryInternalMeetings: deps.queryInternalMeetings ?? realQueryInternalMeetings,
    now: deps.now ?? (() => new Date()),
  };
}

/** Filters (minus status) → the page's Mongo filter + scheduledAt bounds. */
function baseFilter(filters, now) {
  const { search, when = 'any', scheduledBetween } = filters || {};
  const filter = buildInternalMeetingsMongoFilter(search ? { search } : {});
  const and = filter.$and ? [...filter.$and] : [];
  const { scheduledFrom, scheduledTo } = dayRange('scheduled', scheduledBetween);
  const at = {};
  if (scheduledFrom) at.$gte = new Date(scheduledFrom);
  if (scheduledTo) at.$lte = new Date(scheduledTo);
  if (Object.keys(at).length) and.push({ scheduledAt: at });
  if (when === 'upcoming') and.push({ scheduledAt: { $gte: now } });
  if (when === 'past') and.push({ scheduledAt: { $lt: now } });
  return and.length ? { $and: and } : {};
}

function withStatus(filter, status) {
  if (!status) return filter;
  return { $and: [...(filter.$and || []), { status }] };
}

/** Page-visible fields only: no description, no invite list (invitedCount instead). */
function toRecord(m) {
  return {
    id: String(m.id ?? m._id ?? ''),
    title: m.title ?? null,
    scheduledAt: m.scheduledAt ?? null,
    timezone: m.timezone ?? null,
    durationMinutes: m.durationMinutes ?? null,
    meetingType: m.meetingType ?? null,
    status: m.status ?? null,
    hosts: (m.hosts || []).map((h) => h?.nameOrRole || h?.email).filter(Boolean),
    invitedCount: Array.isArray(m.emailInvites) ? m.emailInvites.length : 0,
    createdBy: m.createdBy?.name ?? null,
  };
}

/**
 * Runs the Meetings page query (queryInternalMeetings, which ANDs internalMeetingScope).
 * Count mode returns a per-status breakdown too, and no rows. Ceiling: 4 paginated counts per
 * count call (each resolves the scope); fine at today's volumes — an aggregate in the service
 * is the upgrade if it ever shows up in latency.
 */
export async function runMeetingQuery({ filters = {}, limit, countOnly, user, deps }) {
  const now = deps.now();
  const base = baseFilter(filters, now);
  const scopeOptions = filters.mine ? { listScope: 'mine' } : {};
  const sortBy = filters.when === 'upcoming' ? 'scheduledAt' : '-scheduledAt';
  const run = (filter, lim) => deps.queryInternalMeetings(filter, { limit: lim, page: 1, sortBy }, user, scopeOptions);

  if (countOnly) {
    const [main, ...perStatus] = await Promise.all([
      run(withStatus(base, filters.status), 1),
      ...MEETING_STATUSES.map((s) => run(withStatus(base, s), 1)),
    ]);
    const breakdown = {};
    MEETING_STATUSES.forEach((s, i) => { breakdown[s] = perStatus[i]?.totalResults ?? 0; });
    return { total: main?.totalResults ?? 0, breakdown, filtersApplied: filters };
  }

  const res = await run(withStatus(base, filters.status), limit);
  return {
    total: res?.totalResults ?? 0,
    records: (res?.results || []).map(toRecord),
    filtersApplied: filters,
  };
}

export function meetingCountFacts(kind, total) {
  const fact = { kind, label: 'meetings', total };
  return { counts: [fact], primary: fact };
}
