import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { dayWindowBounds } from '../employees/common.js';
import {
  ACTIVITY_ACCESS, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, ACTION_GROUPS, TARGET_TYPES, isoDay,
  auditScope, auditDeps, passesGate, activityTier, actionGroupOf, actionsInGroup, entityQuery, resolvePersonTarget,
  changesFrom, auditCountFacts,
} from './common.js';

// Page query key → the tool filter the model passed, for reporting filters the viewer's tier drops.
const QUERY_KEY_TO_FILTER = {
  actor: 'actor',
  action: 'action/actionGroup',
  entityType: 'targetType',
  entityId: 'target',
  q: 'search',
  startDate: 'between',
  endDate: 'between',
  includeAttendance: 'actionGroup',
};

function toRecord(r) {
  const actorId = r.actor && typeof r.actor === 'object' ? r.actor.id ?? null : r.actor ?? null;
  return {
    id: String(r.id ?? r._id ?? ''),
    at: r.createdAt ?? null,
    actor: r.actor?.name ?? null,
    actorId: actorId == null ? null : String(actorId),
    action: r.action ?? null,
    group: actionGroupOf(r.action),
    // The page shows the legacy stored "Candidate" type as Employee.
    targetType: r.entityType === 'Candidate' ? 'Employee' : r.entityType ?? null,
    targetId: r.entityId ?? null,
    target: r.entityName ?? null,
    changes: changesFrom(r.action, r.metadata),
  };
}

function buildPageQuery(filters) {
  const { actor, action, actionGroup, targetType, target, search, between } = filters;
  if (action && actionGroup) throw new Error('Pass action or actionGroup, not both.');
  const { from, to } = dayWindowBounds(between);
  const query = {
    ...(actor ? { actor } : {}),
    ...entityQuery(targetType, target),
    ...(search ? { q: search } : {}),
    ...(from ? { startDate: from } : {}),
    ...(to ? { endDate: to } : {}),
  };
  if (action) query.action = action;
  if (actionGroup) {
    query.action = { $in: actionsInGroup(actionGroup) };
    // The service hides attendance.* rows unless asked; the Attendance group is asking.
    if (actionGroup === 'Attendance') query.includeAttendance = 'true';
  }
  return query;
}

export default defineTool({
  name: 'list_activity',
  domain: 'audit',
  kind: 'read',
  description:
    'Activity Logs (audit trail): who did what, to which record, when — with old → new values when the log ' +
    'stored them. Use for "who changed X", "what did <person> do today", "who logged in yesterday", "recent ' +
    'role changes", "who deleted this job". Newest first; total is the full count even when fewer rows come back.',
  measure:
    'Activity log RECORDS (one row per logged action) you can see on the Activity Logs page — everyone\'s with ' +
    'full access, otherwise only your own; attendance punches excluded unless actionGroup is Attendance.',
  input: Joi.object({
    filters: Joi.object({
      actor: Joi.string().min(1).max(100)
        .description('Who did it: a name or email (starts-with match) or a user id. Only viewers with full log access can filter by another person.'),
      action: Joi.string().min(3).max(80)
        .description('One exact action key, e.g. "user.login", "role.update", "user.disable", "employee.transfer", "offer.statusChange".'),
      actionGroup: Joi.string().valid(...ACTION_GROUPS)
        .description('A whole group of actions, same as the Activity Logs Action filter groups. Use instead of action for broad asks ("role or user changes" → "Users & roles").'),
      targetType: Joi.string().valid(...TARGET_TYPES)
        .description('Kind of record acted on. "Employee" covers employee/candidate person records; "User" is a login account.'),
      target: Joi.string().min(1).max(100)
        .description('The record acted on: its name (starts-with match) or id. Needs targetType.'),
      search: Joi.string().min(1).max(200)
        .description('Free text like the page search box: action, record type, names stored on the row, or an actor name.'),
      between: Joi.object({ from: isoDay, to: isoDay })
        .description('When it happened: inclusive whole days (IST).'),
    }),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  }),
  access: ACTIVITY_ACCESS,
  async execute({ filters, limit = DEFAULT_LIST_LIMIT } = {}, ctx) {
    const user = auditScope(ctx);
    const deps = auditDeps(ctx);
    if (!(await passesGate(deps.activityGate, user))) {
      return { forbidden: true, error: 'You do not have permission to view activity logs.' };
    }

    const { uid, resolve, seesEveryone } = activityTier(user, deps);
    const query = buildPageQuery(filters || {});
    const resolved = resolve(query);

    const scopedToYou = !seesEveryone;
    const dropped = Object.keys(query).filter((k) => !(k in resolved) || (k === 'actor' && scopedToYou && query.actor !== uid));
    const ignoredFilters = [...new Set(dropped.map((k) => QUERY_KEY_TO_FILTER[k] ?? k))];
    const filter = await resolvePersonTarget(resolved, deps);

    const page = await deps.queryActivityLogs(
      filter,
      { limit: Math.min(limit, MAX_LIST_LIMIT), page: 1, sortBy: 'createdAt:desc' },
      user,
    );
    return {
      total: page?.totalResults ?? 0,
      records: (page?.results || []).map(toRecord),
      scope: scopedToYou ? 'your own activity only' : 'everyone',
      ...(ignoredFilters.length ? { ignoredFilters } : {}),
      filtersApplied: filters || {},
    };
  },
  render(result) {
    if (!result || result.forbidden) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'activity-log',
      tableType: 'activity-log',
      title: `Activity (${result.total})`,
      columns: [
        { key: 'at', label: 'When', priority: 'primary', format: 'date' },
        { key: 'actor', label: 'Who', priority: 'primary' },
        { key: 'action', label: 'Action', priority: 'primary' },
        { key: 'target', label: 'Record', priority: 'primary' },
        { key: 'changes', label: 'Change', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        at: r.at ?? null,
        actor: r.actor ?? '—',
        action: r.action ?? '—',
        target: r.target ?? r.targetType ?? '—',
        changes: r.changes?.length
          ? r.changes.map((c) => (c.valueHidden || c.valuesNotCaptured ? c.field : `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`)).join('; ')
          : '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: auditCountFacts('list_activity', 'activity records', result.total) };
  },
});
