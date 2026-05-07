// uat.dharwin.backend/src/services/chatAssistant/roleResolver.js
//
// Compatibility shim over roleRegistry.js. Original module owned a hardcoded
// ALIAS_GROUPS map and queried Role with a regex on every call; canonical
// matching now lives in roleRegistry.js (DB-driven, TTL-cached, rename-aware).
// Exported names are preserved so existing callers keep working.

import Role from '../../models/role.model.js';
import {
  resolveRole as registryResolveRole,
  tagRoleDisplayNames,
  loadRoleRegistry,
} from './roleRegistry.js';

/**
 * @deprecated Aliases now live on Role.aliases in MongoDB. Edit the DB,
 * not this map. Kept exported only so old imports still load.
 */
export const ALIAS_GROUPS = {
  Employee:      ['Employee'],
  Candidate:     ['Candidate'],
  Agent:         ['Agent', 'agent'],
  SalesAgent:    ['Sales Agent', 'sales_agent', 'sales agent', 'salesagent'],
  Recruiter:     ['Recruiter'],
  Administrator: ['Administrator'],
  Student:       ['Student'],
};

/**
 * Resolve any role token (slug, current name, alias, previous name) to the
 * canonical slug stored in the registry. Returns the input unchanged when
 * no match exists. Async — the registry is async by design.
 */
export async function canonicalize(name) {
  if (!name) return name;
  const r = await registryResolveRole(name);
  return r.canonical || name;
}

/**
 * Resolve any role input to all matching Role document _id values via the
 * registry. Multiple ids are returned when duplicate Role docs share a token
 * (legacy 'Agent' + 'agent') — caller treats as a set.
 *
 * `RoleModel` parameter is preserved for backward compatibility with tests
 * that inject a stub model; supplying it forces a fresh registry load.
 */
export async function resolveRoleIds(input, RoleModel = Role) {
  if (!input) return { ids: [], names: [] };
  const opts = RoleModel && RoleModel !== Role ? { force: true, RoleModel } : {};
  const r = await registryResolveRole(input, opts);
  return { ids: r.ids, names: r.names };
}

/**
 * Map<idString, displayName> for batch role-tagging. Display names come from
 * the live registry, so renames propagate without code changes.
 */
export async function tagRoleNames(roleIds, RoleModel = Role) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return new Map();
  const opts = RoleModel && RoleModel !== Role ? { force: true, RoleModel } : {};
  return tagRoleDisplayNames(roleIds, opts);
}

export { loadRoleRegistry };
