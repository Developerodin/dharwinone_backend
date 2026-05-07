// uat.dharwin.backend/src/services/chatAssistant/fallbackGenerator.js
//
// Contextual empty-state generator. Replaces the flat hardcoded fallback
// strings (`No employee found`, `No candidate found`, etc.) with a
// builder that explains WHY data is missing (filters, permissions,
// archive, fuzzy matches) and suggests next actions per module.
//
// Returns { block, markdown } so callers can ship both the structured
// FallbackBlock (new client) and the markdown twin (old client / LLM
// context injection).

/**
 * @typedef {object} FallbackCtx
 * @property {string}  module                  - 'employees' | 'jobs' | 'attendance' | 'leave' | 'projects' | 'candidates' | 'students' | string
 * @property {string}  [entityType]            - human label shown to user (singular). Defaults to module.
 * @property {string|null} [queryArg]          - the search arg the user typed
 * @property {object|null} [filters]           - applied filters (role, department, status, ...)
 * @property {object|null} [permissions]       - { scope?:string, denied?:boolean }
 * @property {object|null} [archived]          - { exists:boolean, count?:number }
 * @property {string[]|null} [similarMatches]  - fuzzy candidates (top 3 max are shown)
 * @property {object|null} [scope]             - { dateRange?:string }  (display-only, never parsed)
 */

const NEXT_ACTIONS = {
  employees: (ctx) => [
    'Search by employee ID: `<DBS####>`',
    ctx.archived?.exists && `Include archived: "${ctx.queryArg ?? 'employee'} including resigned"`,
    `List all ${ctx.filters?.role || 'employees'}: "list ${ctx.filters?.role || 'employees'}"`,
  ].filter(Boolean),
  attendance: (ctx) => [
    'Try a wider window: "this week" or "last 30 days"',
    ctx.queryArg && `Check the employee's shift: "show ${ctx.queryArg}'s shift"`,
  ].filter(Boolean),
  jobs: (_ctx) => [
    'List open positions: "open jobs"',
    'Filter by department: "<dept> jobs"',
  ],
  candidates: (_ctx) => [
    'Search by email or phone',
    'Check archived candidates',
  ],
  students: (_ctx) => [
    'Search by group or batch',
    'Check archived students',
  ],
  projects: (_ctx) => [
    'List active projects',
    'Search by client: "projects for <client>"',
  ],
  leave: (_ctx) => [
    'Try a date range: "leave last month"',
    'Filter by status: "pending leave"',
  ],
  onboarding: (_ctx) => [
    'List in-progress onboarding',
    'Search by hire date',
  ],
};

const DEFAULT_NEXT = (ctx) => [
  ctx.queryArg && `Check spelling of "${ctx.queryArg}"`,
  'Try a broader query',
].filter(Boolean);

function pickEntityType(ctx) {
  if (ctx.entityType) return ctx.entityType;
  if (ctx.module === 'employees')   return 'employee';
  if (ctx.module === 'attendance')  return 'attendance record';
  if (ctx.module === 'jobs')        return 'job';
  if (ctx.module === 'candidates')  return 'candidate';
  if (ctx.module === 'students')    return 'student';
  if (ctx.module === 'projects')    return 'project';
  if (ctx.module === 'leave')       return 'leave record';
  if (ctx.module === 'onboarding')  return 'onboarding record';
  return ctx.module || 'record';
}

function pickReasons(ctx) {
  /** @type {string[]} */
  const reasons = [];
  if (ctx.archived?.exists) {
    const count = typeof ctx.archived.count === 'number' ? ` (${ctx.archived.count})` : '';
    reasons.push(`exists in **archived** ${pickEntityType(ctx)}s${count}`);
  }
  if (ctx.similarMatches && ctx.similarMatches.length) {
    const top = ctx.similarMatches.slice(0, 3).map((s) => `\`${s}\``).join(', ');
    reasons.push(`found similar names: ${top}`);
  }
  if (ctx.filters?.role)        reasons.push(`filter \`role=${ctx.filters.role}\` is active`);
  if (ctx.filters?.department)  reasons.push(`filter \`department=${ctx.filters.department}\` is active`);
  if (ctx.filters?.status)      reasons.push(`filter \`status=${ctx.filters.status}\` is active`);
  if (ctx.permissions?.denied)  reasons.push(`your role can only see ${ctx.permissions.scope || 'a limited scope'}`);
  if (ctx.scope?.dateRange)     reasons.push(`searched range \`${ctx.scope.dateRange}\``);
  return reasons;
}

function pickSuggestions(ctx) {
  const fn = NEXT_ACTIONS[ctx.module] || DEFAULT_NEXT;
  return fn(ctx);
}

/**
 * Build a contextual fallback. Returns block + markdown twin.
 *
 * @param {FallbackCtx} ctx
 * @returns {{ block: object, markdown: string }}
 */
export function buildFallback(ctx) {
  const safeCtx = ctx || { module: 'unknown' };
  const entity = pickEntityType(safeCtx);
  const reasons = pickReasons(safeCtx);
  const suggestions = pickSuggestions(safeCtx);

  const title = safeCtx.queryArg
    ? `No active **${entity}** matched **"${safeCtx.queryArg}"**.`
    : `No **${entity}** match the current filters.`;

  /** @type {object} */
  const block = {
    type: 'fallback',
    kind: safeCtx.module || 'unknown',
    title,
    reasons,
    suggestions,
  };
  if (safeCtx.queryArg) block.query = safeCtx.queryArg;

  const reasonsMd = reasons.length
    ? `\n\nWhy this might be:\n${reasons.map((r) => `- ${r}`).join('\n')}`
    : '';
  const suggestionsMd = suggestions.length
    ? `\n\nTry next:\n${suggestions.map((s) => `- ${s}`).join('\n')}`
    : '';
  const markdown = title + reasonsMd + suggestionsMd;

  return { block, markdown };
}

/**
 * Detect whether a `fetched[entryKey]` payload is a "no match" result that
 * should route to the fallback generator. Uses conventions observed in the
 * existing codebase (notFound / needsTimeWindow flags + empty
 * records/total).
 *
 * @param {object|null|undefined} payload
 * @returns {boolean}
 */
export function isEmptyResult(payload) {
  if (!payload) return true;
  if (payload.notFound) return true;
  if (payload.needsTimeWindow) return false; // input was incomplete, not "no result"
  if (Array.isArray(payload.records) && payload.records.length === 0) return true;
  if (typeof payload.total === 'number' && payload.total === 0) return true;
  return false;
}

/**
 * Map a fact `kind` → module slug used by the suggestion table.
 * @param {string} kind
 * @returns {string}
 */
export function moduleForKind(kind) {
  switch (kind) {
    case 'fetch_employees':                          return 'employees';
    case 'fetch_people':                             return 'employees';
    case 'attendance_summary_day':
    case 'attendance_summary_range':                 return 'attendance';
    case 'fetch_leave_requests':                     return 'leave';
    case 'fetch_backdated_attendance_requests':      return 'attendance';
    case 'fetch_jobs':                               return 'jobs';
    case 'fetch_candidates':                         return 'candidates';
    case 'fetch_placements':                         return 'onboarding';
    case 'fetch_offers':                             return 'jobs';
    case 'fetch_roles':                              return 'employees';
    default:                                         return kind || 'unknown';
  }
}
