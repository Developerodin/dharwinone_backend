// uat.dharwin.backend/src/services/chatAssistant/visibilityRules.js
//
// SINGLE SOURCE OF TRUTH for which User states the chatbot can see.
// Every chatbot retrieval path — counts, lists, direct lookups, role queries,
// attendance aggregator — must use these helpers so a "list" cannot return
// rows that a "count" excluded, and a "direct lookup" cannot leak rows that
// a "list" hid.
//
// Defaults:
//   visible:     active, pending
//   excluded:    disabled, archived, deleted
// Operator can widen via env vars or chatbot config; "deleted" is NEVER visible.

import config from '../../config/config.js';

const DEFAULT_VISIBLE = ['active', 'pending'];

function readBoolEnv(name) {
  const v = process.env[name];
  if (v == null) return undefined;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function getCfg() {
  const fileCfg = (config && config.chatbot && config.chatbot.visibility) || {};
  return {
    includeDisabled: readBoolEnv('CHATBOT_INCLUDE_DISABLED') ?? !!fileCfg.includeDisabled,
    includeArchived: readBoolEnv('CHATBOT_INCLUDE_ARCHIVED') ?? !!fileCfg.includeArchived,
  };
}

/**
 * Return the list of User.status values currently visible to the chatbot.
 * Caller-supplied overrides win over global config so a single tool call can
 * widen visibility ("list disabled agents") without changing the default.
 *
 * @param {{ includeDisabled?: boolean, includeArchived?: boolean }} [override]
 * @returns {string[]}
 */
export function getVisibleUserStatuses(override = {}) {
  const cfg = getCfg();
  const allowed = new Set(DEFAULT_VISIBLE);
  if (override.includeDisabled || cfg.includeDisabled) allowed.add('disabled');
  if (override.includeArchived || cfg.includeArchived) allowed.add('archived');
  // 'deleted' NEVER visible — privacy/compliance hard rule.
  return [...allowed];
}

/**
 * Mongo `$in` clause for User.status. Plug into every User query.
 * @param {{ includeDisabled?: boolean, includeArchived?: boolean }} [override]
 */
export function visibleUserStatusClause(override) {
  return { $in: getVisibleUserStatuses(override) };
}

/**
 * Owner-account query for Employee-role people. Use this everywhere the
 * chatbot resolves "which User accounts own an Employee profile".
 *
 * Deliberately takes NO employment-scope argument. Employment scope
 * (active / resigned / all) describes the EMPLOYMENT RECORD via
 * Employee.resignDate; it must never widen ACCOUNT visibility. The legacy
 * fetch_employees path used to branch to `{ $ne: 'deleted' }` for
 * resigned/all, which surfaced disabled accounts that the Employees page
 * hides — the chatbot reported 35 resigned employees where the site
 * reported 34.
 *
 * @param {{ roleIds: any[], override?: { includeDisabled?: boolean, includeArchived?: boolean } }} args
 */
export function employeeOwnerQuery({ roleIds, override } = {}) {
  return {
    roleIds: { $in: roleIds },
    status: visibleUserStatusClause(override),
    platformSuperUser: { $ne: true },
  };
}

/**
 * Predicate — returns true when a hydrated user record passes visibility rules.
 * Use after hydration when the source query couldn't apply the clause directly
 * (e.g. orphan join via Employee.fullName).
 */
export function canUserBeVisible(user, override) {
  if (!user) return false;
  if (user.platformSuperUser) return false;
  if (user.status === 'deleted') return false;
  return getVisibleUserStatuses(override).includes(user.status);
}

/**
 * Resolve override flags from a tool-call args bag. Lets the LLM ask for
 * disabled/archived users explicitly without changing the default behaviour.
 */
export function overridesFromArgs(args = {}) {
  return {
    includeDisabled: !!(args.includeDisabled || args.includeHidden || args.status === 'disabled'),
    includeArchived: !!(args.includeArchived || args.status === 'archived'),
  };
}
