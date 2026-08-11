import { DEFAULT_PAGINATION, ENTITY_EMPLOYEES } from '../../../schemas/entityQuery.contract.js';
import { looksLikeReferenceFollowUp, RESOLVED_FOLLOWUP_RE } from '../referenceResolver.js';
import { parseFiltersFromMessage, looksLikeEmployeeFilterQuery } from './nlResolver.js';
import { hasExplicitOperation, planOperations } from '../../../schemas/operationPlanner.js';

const FILTER_KEYS = [
  'employmentStatus',
  'compensationType',
  'search',
  'fullName',
  'email',
  'employeeId',
  'id',
  'agent',
  'agentIds',
  'designation',
];

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

function copyFilterSource(source, target) {
  if (!source || typeof source !== 'object') return target;
  for (const key of FILTER_KEYS) {
    if (isPresent(source[key])) {
      target[key] = source[key];
    }
  }
  if (isPresent(source.search) && !isPresent(target.search)) {
    target.search = source.search;
  }
  return target;
}

function isVagueEmployeeQuery(userMessage) {
  const text = String(userMessage || '').trim();
  return /^\s*how many\?\s*$/i.test(text) || /^\s*list them\s*$/i.test(text);
}

function filtersEqual(a = {}, b = {}) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * Merge filters with priority: explicit NL > lastContext > UI activeFilters.
 * UI employmentStatus is only inherited for vague follow-ups — broad list/count queries
 * must not pick up the Employees page tab filter.
 *
 * @param {Record<string, string>} nlFilters
 * @param {object|null} lastContext
 * @param {object|null} uiContext
 * @param {{ inheritUiEmploymentStatus?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function mergeEmployeeFilters(
  nlFilters,
  lastContext = null,
  uiContext = null,
  { inheritUiEmploymentStatus = false } = {}
) {
  const merged = {};
  const uiFilters = { ...(uiContext?.activeFilters || {}) };
  if (!inheritUiEmploymentStatus) {
    delete uiFilters.employmentStatus;
  }

  copyFilterSource(uiFilters, merged);

  if (isPresent(uiContext?.search) && !isPresent(merged.search)) {
    merged.search = uiContext.search;
  }

  copyFilterSource(lastContext?.filters, merged);
  copyFilterSource(nlFilters, merged);

  const positionState = lastContext?.positionConversationState;
  if (positionState?.entity === 'employee' && positionState.designation && !merged.designation) {
    merged.designation = positionState.designation;
  }

  return merged;
}

function ensureEmploymentStatusDefault(filters, userMessage) {
  if (isPresent(filters.employmentStatus)) return filters;
  if (looksLikeEmployeeFilterQuery(userMessage)) {
    filters.employmentStatus = 'all';
  }
  return filters;
}

/**
 * A message that names the entity outright ("how many active employees are there")
 * is a complete question, not a continuation — it must not silently inherit the
 * previous turn's filters. An alias-only fragment ("what about paid") is a
 * continuation and keeps the established scope.
 *
 * ponytail: noun-presence is the whole heuristic. A genuinely anaphoric sentence
 * that still names the noun ("how many of those employees are unpaid") resets
 * scope too; tighten with a pronoun check only if that shows up in real traffic.
 */
const ENTITY_NOUN_RE = /\b(employees?|staff|workforce|team members?|headcount|people)\b/i;

function startsFreshScope(userMessage) {
  return ENTITY_NOUN_RE.test(String(userMessage || ''));
}

function isEmployeeListFollowUp(userMessage, lastContext) {
  const text = String(userMessage || '').trim();
  if (!text || !lastContext || lastContext.entity !== ENTITY_EMPLOYEES) return false;
  if (!looksLikeReferenceFollowUp(text)) return false;
  return RESOLVED_FOLLOWUP_RE.test(text);
}

/**
 * Resolve a natural-language employee query into a StructuredQuery shell.
 *
 * @param {{
 *   userMessage: string,
 *   uiContext?: object|null,
 *   lastContext?: object|null,
 * }} input
 * @returns {object}
 */
export function resolveEmployeeStructuredQuery({ userMessage, uiContext = null, lastContext = null }) {
  const message = String(userMessage || '').trim();
  const followUp = isEmployeeListFollowUp(message, lastContext);

  // Context from another module is not our context. copyFilterSource matches on
  // key NAME only, so a jobs/users `search`/`id`/`pagination` would otherwise be
  // replayed as employee filters. isEmployeeListFollowUp already guards this for
  // the follow-up path; the inherit path needs the same check.
  const sameEntityContext = lastContext?.entity === ENTITY_EMPLOYEES ? lastContext : null;
  const priorContext = startsFreshScope(message) ? null : sameEntityContext;
  const inheritsScope = !followUp && !!priorContext;

  const positionState = lastContext?.positionConversationState;
  const hasPositionDesignation =
    positionState?.entity === 'employee' &&
    positionState.designation &&
    !/\b(jobs?|openings?|vacanc(?:y|ies)|postings?)\b/i.test(message);

  const nlFilters = followUp
    ? {}
    : parseFiltersFromMessage(message, { applyStatusDefault: !inheritsScope && !hasPositionDesignation });
  const filters = followUp
    ? ensureEmploymentStatusDefault(copyFilterSource(priorContext?.filters, {}), message)
    : ensureEmploymentStatusDefault(
        mergeEmployeeFilters(nlFilters, priorContext, uiContext, {
          inheritUiEmploymentStatus: isVagueEmployeeQuery(message),
        }),
        message
      );

  // "what about paid" names no operation — keep answering the question the user
  // actually asked last turn instead of falling back to a list dump.
  const inheritsOperation =
    inheritsScope && !hasExplicitOperation(message) && priorContext.operations?.length > 0;

  let operations;
  if (followUp) {
    operations = ['list'];
  } else if (inheritsOperation) {
    operations = [...priorContext.operations];
  } else {
    operations = planOperations(message);
  }

  const query = {
    entity: ENTITY_EMPLOYEES,
    operations,
    relations: [],
    pagination:
      followUp || (inheritsScope && filtersEqual(filters, priorContext?.filters ?? {}))
        ? priorContext?.pagination
          ? { ...priorContext.pagination }
          : { ...DEFAULT_PAGINATION }
        : { ...DEFAULT_PAGINATION },
  };

  if (Object.keys(filters).length > 0) {
    query.filters = filters;
  }

  if (priorContext?.scope) {
    query.scope = { ...priorContext.scope };
  } else if (uiContext?.currentModule) {
    query.scope = { module: String(uiContext.currentModule).toLowerCase() };
  }

  return query;
}

/**
 * Stub hook for referenceResolver integration (Task 7 wires entityQuery flag).
 *
 * @param {string} text
 * @param {object|null} memory
 * @param {{ entityQueryEnabled?: boolean }} [opts]
 * @returns {{ entity: string, operations: string[], filters: object, useEntityQuery: true }|null}
 */
export function resolveEmployeeLastContextFollowUp(text, memory = null, { entityQueryEnabled = false } = {}) {
  if (!entityQueryEnabled) return null;

  const lastContext = memory?.lastContext;
  if (!isEmployeeListFollowUp(text, lastContext)) return null;

  return {
    entity: ENTITY_EMPLOYEES,
    operations: ['list'],
    filters: { ...(lastContext.filters || {}) },
    useEntityQuery: true,
  };
}
