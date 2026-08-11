import { hasExplicitOperation, planOperations } from '../../../schemas/operationPlanner.js';
import { parseFiltersFromMessage } from '../entityQuery/nlResolver.js';
import { resolveRole, loadRoleRegistry } from '../roleRegistry.js';
import { AGENT_EMPLOYEE_RELATION } from '../agentEmployeeRelation.js';
import User from '../../../models/user.model.js';
import { visibleUserStatusClause, canUserBeVisible } from '../visibilityRules.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenize = (s) => String(s || '').toLowerCase().split(/[\s,._-]+/).filter(Boolean);

function scoreAgentNameMatch(query, doc) {
  const q = String(query || '').trim();
  if (!q) return 0;
  const lcQuery = q.toLowerCase();

  if ((doc.email || '').toLowerCase() === lcQuery) return 1;

  const qTokens = tokenize(q);
  if (qTokens.length === 0) return 0;

  const dHaystack = [doc.name, doc.email, ...(doc.previousNames || []), ...(doc.aliases || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const dTokens = tokenize(dHaystack);

  let prefixHits = 0;
  let exactHits = 0;
  for (const qt of qTokens) {
    if (dTokens.includes(qt)) exactHits += 1;
    else if (dTokens.some((dt) => dt.startsWith(qt))) prefixHits += 1;
  }

  const score = (exactHits * 1.0 + prefixHits * 0.7) / qTokens.length;
  const verbatim = dHaystack.includes(lcQuery) ? 0.1 : 0;
  return Math.min(1, score + verbatim);
}

const STATUS_FOLLOWUP_RE =
  /\b(active|working|currently[- ]working|on[- ]roll|resigned|unpaid|paid|pending|disabled|deleted|all|everyone)\b/i;

const EMPLOYEE_AGENT_LOOKUP_RE =
  /\b(who is|who'?s|who handles|who manages|assigned agent for|agent for)\b/i;

const POSSESSIVE_AGENT_RE = /\b(.+?)['']s\s+agent\b/i;

const AGENT_POSSESSIVE_EMPLOYEES_RE =
  /\b(.+?)['']s\s+(employees?|staff|team)\b/i;

const ASSIGNED_TO_AGENT_RE =
  /\b(?:employees?|staff)\s+(?:are\s+)?(?:assigned\s+(?:to|for)|under|with)\s+(.+?)(?:\?|$)/i;

const AGENT_EMPLOYEE_COUNT_RE =
  /\b(?:(?:how|who)\s+many|count|number of)\b.*\b(employees?|staff)\b.*\b(assigned|for|under|with)\b/i;

const AGENT_EMPLOYEE_LIST_RE =
  /\b(which|what|show|list|name)\b.*\b(employees?|staff)\b.*\b(assigned|for|under)\b/i;

const AGENT_RANKING_RE =
  /\b(which|what)\s+agents?\b.*\b(most|highest|top|maximum)\b.*\bemployees?\b/i;

const UNASSIGNED_COUNT_RE =
  /\b(how many|count|number of)\b.*\b(unassigned|without\s+(?:an?\s+)?agents?|no\s+agents?)\b/i;

const AGENTS_NO_EMPLOYEES_RE =
  /\b(which|what)\s+agents?\b.*\b(no|zero|without)\b.*\bemployees?\b/i;

const AGENT_COUNT_CHALLENGE_RE =
  /\b(are you sure|is that (?:correct|right)|confirm|verify|double[- ]check)\b/i;

const AGENT_COUNT_DISPUTE_RE =
  /\b(only|just)\s+\d+\b.*\b(employees?|assigned|staff)\b/i;

/**
 * @typedef {'agent_employee_count'|'agent_employee_list'|'employee_agent_lookup'|'agent_ranking'|'unassigned_count'|'agents_no_employees'} AgentEmployeeIntent
 */

/**
 * @param {string} message
 * @param {{ currentAgentSubject?: object|null, lastContext?: object|null }} ctx
 * @returns {AgentEmployeeIntent|null}
 */
function normalizeAgentQueryText(message) {
  return String(message || '')
    .trim()
    .replace(/\bwho\s+many\b/i, 'how many');
}

export function detectAgentEmployeeIntent(message, ctx = {}) {
  const text = normalizeAgentQueryText(message);
  if (!text) return null;

  if (EMPLOYEE_AGENT_LOOKUP_RE.test(text) || POSSESSIVE_AGENT_RE.test(text)) {
    return 'employee_agent_lookup';
  }
  if (AGENT_RANKING_RE.test(text)) return 'agent_ranking';
  if (UNASSIGNED_COUNT_RE.test(text)) return 'unassigned_count';
  if (AGENTS_NO_EMPLOYEES_RE.test(text)) return 'agents_no_employees';

  if (
    AGENT_EMPLOYEE_LIST_RE.test(text) ||
    (/\b(which|show|list|name)\b/i.test(text) && /\bassigned\b/i.test(text))
  ) {
    return 'agent_employee_list';
  }

  if (
    AGENT_EMPLOYEE_COUNT_RE.test(text) ||
    AGENT_POSSESSIVE_EMPLOYEES_RE.test(text) ||
    ASSIGNED_TO_AGENT_RE.test(text)
  ) {
    return 'agent_employee_count';
  }

  if (AGENT_COUNT_CHALLENGE_RE.test(text) || AGENT_COUNT_DISPUTE_RE.test(text)) {
    if (extractAgentNamesFromMessage(text).length || ctx.currentAgentSubject?.agentId) {
      return 'agent_employee_count';
    }
  }

  const agentSubject = ctx.currentAgentSubject;
  if (
    agentSubject?.agentId &&
    STATUS_FOLLOWUP_RE.test(text) &&
    !/\b(candidates?|students?)\b/i.test(text)
  ) {
    return hasExplicitOperation(text) || /\bhow many\b/i.test(text)
      ? 'agent_employee_count'
      : 'agent_employee_count';
  }

  return null;
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/\?+$/, '')
    .replace(/\bhow many of\s+/gi, '')
    .replace(/\b(the|this|that)\b/gi, '')
    .replace(/\b(employees?|staff|agent|agents?)\b/gi, '')
    .trim();
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function splitAgentNames(raw) {
  return String(raw || '')
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((part) => cleanName(part))
    .filter((name) => name.length >= 2);
}

/**
 * @param {string} message
 * @returns {string|null}
 */
export function extractAgentNameFromMessage(message) {
  const names = extractAgentNamesFromMessage(message);
  return names[0] ?? null;
}

/**
 * @param {string} message
 * @returns {string[]}
 */
export function extractAgentNamesFromMessage(message) {
  const text = normalizeAgentQueryText(message);
  const patterns = [
    AGENT_POSSESSIVE_EMPLOYEES_RE,
    /\bassigned\s+(?:to|for)\s+(.+?)(?:\?|$)/i,
    /\b(?:for|under|with)\s+(.+?)(?:['']s)?\s+(?:employees?|staff)\b/i,
    ASSIGNED_TO_AGENT_RE,
    /\b(?:are you sure|confirm|verify|double[- ]check)\s+(.+?)\s+(?:has|have)\b/i,
    /\b(.+?)\s+has\s+(?:only|just)\s+\d+\b/i,
  ];
  for (const re of patterns) {
    const hit = text.match(re);
    if (hit?.[1]) {
      const names = splitAgentNames(hit[1]);
      if (names.length) return names;
    }
  }
  return [];
}

/**
 * @param {string} message
 * @returns {string|null}
 */
export function extractEmployeeNameFromMessage(message) {
  const text = String(message || '').trim();
  const possessive = text.match(POSSESSIVE_AGENT_RE);
  if (possessive?.[1]) {
    const name = cleanName(possessive[1]);
    if (name.length >= 2) return name;
  }
  const handles = text.match(/\b(?:handles|manages)\s+(.+?)(?:\?|$)/i);
  if (handles?.[1]) {
    const name = cleanName(handles[1]);
    if (name.length >= 2) return name;
  }
  return null;
}

/**
 * Resolve a name against Agent-role Users only (assignment queries never search employees).
 *
 * @param {string} name
 * @param {object} [deps]
 */
export async function resolveAgentUser(name, deps = {}) {
  const loadRegistry = deps.loadRoleRegistry ?? loadRoleRegistry;
  const resolveRoleFn = deps.resolveRole ?? resolveRole;
  const UserModel = deps.User ?? User;

  const trimmed = String(name || '').trim();
  if (!trimmed) return { kind: 'notFound' };

  const agentRole = await resolveRoleFn(AGENT_EMPLOYEE_RELATION.agentUserRoleName, {
    loadRoleRegistry: loadRegistry,
    ...deps,
  });
  const agentRoleIds = (agentRole.ids || []).map(String);
  if (!agentRoleIds.length) return { kind: 'notFound' };

  const safe = escapeRegex(trimmed);
  const tokens = tokenize(trimmed).filter((t) => t.length >= 2);
  const tokenOr = tokens.map((t) => ({ name: { $regex: escapeRegex(t), $options: 'i' } }));
  const userOr = [
    { name: { $regex: safe, $options: 'i' } },
    { email: { $regex: safe, $options: 'i' } },
    { previousNames: { $regex: safe, $options: 'i' } },
    { aliases: { $regex: safe, $options: 'i' } },
    ...tokenOr,
  ];

  const users = await UserModel.find({
    status: visibleUserStatusClause(deps.visibility),
    roleIds: { $in: agentRoleIds },
    $or: userOr,
  })
    .select('_id name email phoneNumber roleIds status platformSuperUser previousNames aliases hideFromDirectory')
    .limit(50)
    .lean();

  const viewer = deps.viewer ?? null;
  const viewerIsSuper = !!viewer?.platformSuperUser;
  const candidates = users
    .filter((u) => {
      if (viewer && String(viewer._id) === String(u._id)) return true;
      if (viewerIsSuper) return true;
      return !u.hideFromDirectory && !u.platformSuperUser;
    })
    .map((u) => ({
      userId: u._id,
      empDocId: null,
      employeeId: null,
      name: u.name,
      email: u.email || null,
      phone: u.phoneNumber || null,
      roleIds: u.roleIds || [],
      score: scoreAgentNameMatch(trimmed, u),
    }))
    .filter((m) => m.score >= (deps.minScore ?? 0.5))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return { kind: 'notFound' };

  const top = candidates[0];
  const second = candidates[1];
  const uniqueGap = deps.uniqueGap ?? 0.25;
  if (candidates.length === 1 || (second && top.score - second.score >= uniqueGap)) {
    return { kind: 'unique', match: top };
  }
  return { kind: 'ambiguous', matches: candidates.slice(0, deps.limit ?? 10) };
}

/**
 * @param {{
 *   userMessage: string,
 *   currentAgentSubject?: object|null,
 *   lastContext?: object|null,
 * }} input
 * @returns {Promise<object|null>}
 */
export async function planAgentQuery({ userMessage, currentAgentSubject = null, lastContext = null, deps = {} }) {
  const message = String(userMessage || '').trim();
  const intent = detectAgentEmployeeIntent(message, { currentAgentSubject, lastContext });
  if (!intent) return null;

  const nlFilters = parseFiltersFromMessage(message, { applyStatusDefault: false });

  if (
    !nlFilters.employmentStatus &&
    !nlFilters.accountStatusScope &&
    currentAgentSubject?.statusScope
  ) {
    const scope = currentAgentSubject.statusScope;
    if (scope === 'active' || scope === 'current') nlFilters.employmentStatus = 'current';
    else if (scope === 'resigned') nlFilters.employmentStatus = 'resigned';
    else if (scope === 'all') nlFilters.employmentStatus = 'all';
    else if (scope === 'pending' || scope === 'disabled' || scope === 'deleted') {
      nlFilters.accountStatusScope = scope;
    }
  }

  if (intent === 'employee_agent_lookup') {
    const employeeName =
      extractEmployeeNameFromMessage(message) ||
      currentAgentSubject?.name ||
      lastContext?.lastResultList?.[0]?.name ||
      null;
    return { intent, employeeName, filters: nlFilters };
  }

  if (intent === 'agent_ranking' || intent === 'unassigned_count' || intent === 'agents_no_employees') {
    return { intent, filters: nlFilters };
  }

  const agentNames = extractAgentNamesFromMessage(message);
  let agentId = null;
  let agentDisplayName = null;
  let resolvedAgentIds = [];
  let resolvedAgentNames = [];

  if (!agentNames.length && currentAgentSubject?.agentId) {
    agentId = currentAgentSubject.agentId;
    agentDisplayName = currentAgentSubject.name;
    resolvedAgentIds = [agentId];
    resolvedAgentNames = [agentDisplayName];
  } else if (agentNames.length) {
    for (const agentName of agentNames) {
      const resolved = await resolveAgentUser(agentName, deps);
      if (resolved.kind === 'ambiguous') {
        return { intent: 'ambiguous_agent', matches: resolved.matches, filters: nlFilters };
      }
      if (resolved.kind === 'notFound') {
        return { intent: 'agent_not_found', name: agentName, filters: nlFilters };
      }
      resolvedAgentIds.push(String(resolved.match.userId));
      resolvedAgentNames.push(resolved.match.name);
    }
    if (resolvedAgentIds.length === 1) {
      agentId = resolvedAgentIds[0];
      agentDisplayName = resolvedAgentNames[0];
    }
  }

  if (!resolvedAgentIds.length) return null;

  const operations =
    intent === 'agent_employee_list' || (planOperations(message).includes('list') && !planOperations(message).includes('count'))
      ? ['list']
      : ['count'];

  const filters = {
    agentIds: resolvedAgentIds,
    ...nlFilters,
  };

  return {
    intent,
    agentId,
    agentIds: resolvedAgentIds,
    agentName: agentDisplayName || resolvedAgentNames[0] || agentNames[0],
    agentNames: resolvedAgentNames,
    operations,
    filters,
  };
}
