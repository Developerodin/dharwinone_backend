import mongoose from 'mongoose';
import UserModel from '../../../../../models/user.model.js';
import RoleModel, { slugifyRole } from '../../../../../models/role.model.js';
import {
  buildUserListMongoFilter as realBuildUserListMongoFilter,
  getUserByIdForRequester as realGetUserByIdForRequester,
  queryUsers as realQueryUsers,
} from '../../../../user.service.js';
import { queryRoles as realQueryRoles } from '../../../../role.service.js';
import { getMyPermissionsForFrontend as realGetMyPermissionsForFrontend } from '../../../../permission.service.js';
import { resolvePersonProfile as realResolvePersonProfile } from '../../../personProfile/index.js';
import { resolveRowScope as realResolveRowScope } from '../../../toolAccess.js';
import {
  viewerSeesHiddenUsers as realViewerSeesHiddenUsers,
  getDirectoryHiddenUserIds as realGetDirectoryHiddenUserIds,
} from '../../../../../utils/platformAccess.util.js';
import { withDefaultStatus } from './filters.js';

export const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** Fail-closed guard, mirrors jobs' jobScope(ctx). */
export function peopleScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('people tools need an authenticated user with an id');
  }
  return ctx.user;
}

export const PEOPLE_ACCESS = Object.freeze({ anyOf: ['users.read'] }); // count_users, list_users
export const PEOPLE_PROFILE_ACCESS = Object.freeze({ anyOf: ['users.read'], rowScope: 'person' }); // get_user
export const ROLES_ACCESS = Object.freeze({ anyOf: ['roles.read'] }); // list_roles, get_role

/** Unconditional — mirrors role.service.js's getAssigneeCountsByRoleId. CONTRACT.md Ruling R1. */
export const EXCLUDE_PLATFORM_SUPER = { platformSuperUser: { $ne: true } };

/**
 * Injectable model/service seam for one tool call — ctx.deps overrides for tests,
 * the same idiom as jobs' jobScope(ctx) returning { Job, visibilityFilter }. Every
 * people/role tool reads its models and service calls through this, never a bare
 * import, so tests never touch Mongo (task instructions: no DB access in tests).
 */
export function peopleDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    User: deps.User ?? UserModel,
    Role: deps.Role ?? RoleModel,
    buildUserListMongoFilter: deps.buildUserListMongoFilter ?? realBuildUserListMongoFilter,
    getUserByIdForRequester: deps.getUserByIdForRequester ?? realGetUserByIdForRequester,
    queryUsers: deps.queryUsers ?? realQueryUsers,
    resolvePersonProfile: deps.resolvePersonProfile ?? realResolvePersonProfile,
    resolveRowScope: deps.resolveRowScope ?? realResolveRowScope,
    viewerSeesHiddenUsers: deps.viewerSeesHiddenUsers ?? realViewerSeesHiddenUsers,
    getDirectoryHiddenUserIds: deps.getDirectoryHiddenUserIds ?? realGetDirectoryHiddenUserIds,
    queryRoles: deps.queryRoles ?? realQueryRoles,
    getMyPermissionsForFrontend: deps.getMyPermissionsForFrontend ?? realGetMyPermissionsForFrontend,
    now: deps.now ?? (() => new Date()),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * inactiveDays / neverLoggedIn → lastLoginAt clauses (CONTRACT.md Ruling R16). lastLoginAt is written
 * only by password sign-in (auth.controller login), so it is "last password sign-in", not last activity.
 */
function loginClauses({ inactiveDays, neverLoggedIn }, now) {
  const clauses = [];
  if (inactiveDays) {
    const cutoff = new Date(now.getTime() - inactiveDays * DAY_MS);
    clauses.push({ $or: [{ lastLoginAt: { $lt: cutoff } }, { lastLoginAt: null, createdAt: { $lt: cutoff } }] });
  }
  if (neverLoggedIn === true) clauses.push({ lastLoginAt: null });
  if (neverLoggedIn === false) clauses.push({ lastLoginAt: { $ne: null } });
  return clauses;
}

/**
 * Resolve free-form role name(s) to Role _ids by direct Role-collection lookup —
 * NOT roleRegistry (its cache is active-only + 60s TTL; a role filter must still
 * match an inactive role that still has assigned users, and must not depend on
 * cache warm state for a deterministic tool call). Exact, case-insensitive match
 * only, against: name, slug (slugifyRole(input) compared to stored slug), any
 * alias, any previousNames[].name. No partial/substring matching — a headcount
 * tool must not silently guess. CONTRACT.md §1 / Ruling R2.
 * @param {string[]} names
 * @returns {Promise<{ ids: string[], unknown: string[], allRoleNames: string[] }>}
 */
export async function resolveRoleNames(names, { Role = RoleModel } = {}) {
  const all = await Role.find(
    {},
    { name: 1, slug: 1, aliases: 1, previousNames: 1, status: 1 }
  ).lean();
  const ids = new Set();
  const unknown = [];
  for (const raw of names) {
    const wanted = String(raw).trim().toLowerCase();
    const wantedSlug = slugifyRole(raw);
    const hit = all.filter((r) =>
      String(r.name).toLowerCase() === wanted ||
      r.slug === wantedSlug ||
      (r.aliases || []).some((a) => String(a).toLowerCase() === wanted) ||
      (r.previousNames || []).some((p) => String(p.name).toLowerCase() === wanted));
    if (!hit.length) unknown.push(raw);
    else hit.forEach((r) => ids.add(String(r._id)));
  }
  return { ids: [...ids], unknown, allRoleNames: all.map((r) => r.name) };
}

/**
 * Batch roleIds -> display names via a direct Role query (not roleRegistry, same
 * inactive-role reason as resolveRoleNames). Used by list_users rows and
 * count_users groupBy:'role' labels.
 */
export async function roleNamesForIds(roleIds, { Role = RoleModel } = {}) {
  const uniq = [...new Set((roleIds || []).map(String))];
  if (!uniq.length) return new Map();
  const docs = await Role.find({ _id: { $in: uniq } }, { name: 1 }).lean();
  return new Map(docs.map((d) => [String(d._id), d.name]));
}

/** Count facts for enforceCounts — every people/user tool reports under the 'users' label. */
export function peopleCountFacts(kind, total) {
  const fact = { kind, label: 'users', total };
  return { counts: [fact], primary: fact };
}

/**
 * Shared mongoFilter construction for count_users/list_users (CONTRACT.md Ruling
 * R5): resolves filters.role to ids (R2/R3 — throws on an unknown name, never a
 * silent empty result), maps location/domain/education to buildUserListMongoFilter's
 * plural keys (R4), strips the Sage-only status:'all' sentinel before querying, and
 * excludes platformSuperUser unconditionally (R1).
 */
export async function buildUserMongoFilter(rawFilters, { groupBy, user, deps } = {}) {
  const filtersApplied = withDefaultStatus(rawFilters, { groupBy });
  // inactiveDays/neverLoggedIn must never reach buildUserListMongoFilter: it spreads unknown keys into Mongo.
  const { role, location, domain, education, status, inactiveDays, neverLoggedIn, ...rest } = filtersApplied;

  let roleIds = [];
  if (role) {
    const names = Array.isArray(role) ? role : [role];
    const resolved = await resolveRoleNames(names, { Role: deps.Role });
    if (resolved.unknown.length) {
      throw new Error(
        `Unknown role name(s): ${resolved.unknown.join(', ')}. Known roles: ${resolved.allRoleNames.join(', ') || '(none)'}.`
      );
    }
    roleIds = resolved.ids;
  }

  const svcFilter = {
    ...rest,
    ...(location ? { locations: [location] } : {}),
    ...(domain ? { domains: [domain] } : {}),
    ...(education ? { education: [education] } : {}),
    ...(status !== 'all' ? { status } : {}),
  };
  const mongoFilter = { ...(await deps.buildUserListMongoFilter(svcFilter, user)), ...EXCLUDE_PLATFORM_SUPER };
  // Cast to ObjectId here, not left as the strings resolveRoleNames returns:
  // countDocuments/find cast a filter automatically, but User.aggregate's
  // $match does not (same class of bug as the recorded "pipeline updates skip
  // Mongoose cast" incident) — count_users' groupBy path would silently match
  // zero documents on a role-filtered aggregate otherwise.
  if (roleIds.length) mongoFilter.roleIds = { $in: roleIds.map((id) => new mongoose.Types.ObjectId(id)) };
  const logins = loginClauses({ inactiveDays, neverLoggedIn }, (deps.now ?? (() => new Date()))());
  if (logins.length) mongoFilter.$and = [...(mongoFilter.$and || []), ...logins];
  return { mongoFilter, filtersApplied };
}
