import { hasExplicitOperation, planOperations } from '../../../schemas/operationPlanner.js';
import { DEFAULT_PAGINATION } from '../../../schemas/entityQuery.contract.js';
import { looksLikeReferenceFollowUp, RESOLVED_FOLLOWUP_RE } from '../referenceResolver.js';
import {
  parseFilterGroupsFromMessage,
  scoreGroupMatch,
  hasGroupSignals,
  parseFilterGroupFromPhrase,
} from './filterGroups.js';

const PAGINATION_RE = /^\s*(next|show more|more|next page)\s*\.?\s*$/i;
const PAGE_NUM_RE = /^\s*page\s+(\d+)\s*\.?\s*$/i;

const GROUP_FOLLOWUP_RE =
  /\b(what about|how about|this one|that one|those ones?|these ones?)\b/i;

/**
 * @param {string} message
 * @param {{ filterGroups?: object[], intent?: string, page?: number, lastPresentedGroupId?: string|null }} queryContext
 * @returns {boolean}
 */
export function isPaginationFollowUp(message, queryContext = null) {
  const text = String(message || '').trim();
  if (!text || !queryContext?.filterGroups?.length) return false;
  return PAGINATION_RE.test(text) || PAGE_NUM_RE.test(text);
}

/**
 * @param {string} message
 * @param {{ filterGroups?: object[] }} queryContext
 * @returns {{ id: string, filters: object }|null}
 */
export function resolveGroupFromContext(message, queryContext = null) {
  if (!queryContext?.filterGroups?.length) return null;

  const text = String(message || '').trim();
  if (!text) return null;

  const isPronounFollowUp = looksLikeReferenceFollowUp(text) && RESOLVED_FOLLOWUP_RE.test(text);
  const isGroupFollowUp = GROUP_FOLLOWUP_RE.test(text);
  const hasFilterTokens = hasGroupSignals(parseFilterGroupFromPhrase(text));

  if (!isPronounFollowUp && !isGroupFollowUp && !hasFilterTokens) return null;

  let best = null;
  let bestScore = 0;
  for (const group of queryContext.filterGroups) {
    const score = scoreGroupMatch(text, group.filters);
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }

  if (bestScore >= 2) return best;
  if (hasFilterTokens && bestScore >= 1) return best;
  return null;
}

/**
 * @param {string} message
 * @param {{ intent?: string }} [queryContext]
 * @returns {'count'|'list'}
 */
function resolveIntent(message, queryContext = null) {
  if (looksLikeReferenceFollowUp(message)) return 'list';
  if (hasExplicitOperation(message)) {
    const ops = planOperations(message);
    return ops.includes('list') && !ops.includes('count') ? 'list' : 'count';
  }
  if (queryContext?.intent === 'list' || queryContext?.intent === 'count') {
    return queryContext.intent;
  }
  const ops = planOperations(message);
  return ops.includes('list') && !ops.includes('count') ? 'list' : 'count';
}

/**
 * @param {string} message
 * @param {{ page?: number }} queryContext
 * @returns {{ page: number, limit: number }}
 */
function resolvePagination(message, queryContext = null) {
  const pageMatch = String(message || '').trim().match(PAGE_NUM_RE);
  if (pageMatch) {
    return { page: Math.max(1, Number(pageMatch[1])), limit: DEFAULT_PAGINATION.limit };
  }
  if (PAGINATION_RE.test(String(message || '').trim())) {
    return {
      page: Math.max(1, (queryContext?.page ?? 1) + 1),
      limit: DEFAULT_PAGINATION.limit,
    };
  }
  return { ...DEFAULT_PAGINATION };
}

/**
 * Plan a structured multi-group employee query, or null to fall through.
 *
 * @param {{
 *   userMessage: string,
 *   queryContext?: object|null,
 *   lastContext?: object|null,
 * }} input
 * @returns {object|null}
 */
export function planEmployeeQuery({ userMessage, queryContext = null, lastContext = null }) {
  const message = String(userMessage || '').trim();
  if (!message) return null;

  const ctx =
    queryContext ??
    lastContext?.currentQueryContext ??
    (lastContext?.filterGroups?.length ? lastContext : null);

  if (isPaginationFollowUp(message, ctx)) {
    const activeId = ctx.lastPresentedGroupId ?? null;
    const groups = activeId
      ? ctx.filterGroups.filter((g) => g.id === activeId)
      : ctx.filterGroups;
    return {
      kind: 'pagination',
      intent: ctx.intent ?? 'list',
      entityType: 'employee',
      operator: ctx.operator ?? 'OR',
      filterGroups: groups,
      activeGroupId: activeId,
      pagination: resolvePagination(message, ctx),
    };
  }

  if (looksLikeReferenceFollowUp(message) && ctx?.filterGroups?.length > 1) {
    return {
      kind: 'compound',
      intent: 'list',
      entityType: 'employee',
      operator: ctx.operator ?? 'OR',
      filterGroups: ctx.filterGroups,
      pagination: { ...DEFAULT_PAGINATION },
    };
  }

  const contextGroup = resolveGroupFromContext(message, ctx);
  if (contextGroup) {
    return {
      kind: 'follow-up-group',
      intent: resolveIntent(message, ctx),
      entityType: 'employee',
      operator: 'OR',
      filterGroups: [contextGroup],
      activeGroupId: contextGroup.id,
      pagination: { ...DEFAULT_PAGINATION },
    };
  }

  const groups = parseFilterGroupsFromMessage(message);
  if (groups.length < 2) return null;

  return {
    kind: 'compound',
    intent: resolveIntent(message, ctx),
    entityType: 'employee',
    operator: 'OR',
    filterGroups: groups,
    pagination: { ...DEFAULT_PAGINATION },
  };
}
