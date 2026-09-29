// src/services/chatAssistant/personProfile/index.js

import { getUserPermissionContext as realPermCtx } from '../../permission.service.js';
import { tagRoleDisplayNames as realNames, tagRoleSlugs as realSlugs } from '../roleRegistry.js';
import { selectProviders as realSelect } from './selectProviders.js';
import { projectFields } from './fieldProjector.js';
import { hasApiPermissionFromContext } from '../../../utils/permissionCheck.js';
import User from '../../../models/user.model.js';

const READ_NAMESPACES = ['employees', 'candidates', 'students', 'mentors', 'recruiters', 'agents'];

/** Minimal identity + roles for a caller-supplied userId. */
function realLoadUserById(id) {
  return User.findById(id).select('name email roleIds').lean();
}

/**
 * Read-only: callers (Sage's get_user / get_my_profile tools) resolve who they
 * mean first and pass the User id.
 *
 * @param {object} a
 * @param {any}    a.userId           the target User id
 * @param {'brief'|'full'} [a.depth]
 * @param {object} a.viewer           req.user
 * @param {boolean} [a.impersonating] true when req.impersonation is present
 * @param {object} [a.deps]           injection seam for tests
 */
export async function resolvePersonProfile({
  userId, depth = 'brief', viewer, impersonating = false, deps = {},
}) {
  const permCtxOf     = deps.getUserPermissionContext ?? realPermCtx;
  const nameTagger    = deps.tagRoleDisplayNames ?? realNames;
  const slugTagger    = deps.tagRoleSlugs ?? realSlugs;
  const pickProviders = deps.selectProviders ?? realSelect;
  const loadUser      = deps.loadUserById ?? realLoadUserById;
  const viewerId      = viewer?.id ?? viewer?._id;

  // Load the row: without roleIds, tagRoleSlugs() below returns an empty Map and
  // the turn would answer kind:'unavailable' for every person.
  const row = userId ? await loadUser(userId) : null;
  if (!row) return { kind: 'notFound' };
  const target = {
    userId: row._id ?? userId,
    name: row.name ?? null,
    email: row.email ?? null,
    roleIds: row.roleIds || [],
  };

  const { permissions } = await permCtxOf(viewer);
  const platformSuperUser = !!viewer?.platformSuperUser;
  const isSelfTarget = String(viewerId) === String(target.userId);
  // Impersonation must not satisfy self: req.user is the impersonated person, so
  // an impersonator would otherwise read orSelf fields they have no permission for.
  const isSelf = !impersonating && isSelfTarget;

  const canReadAny = READ_NAMESPACES.some((ns) =>
    hasApiPermissionFromContext(permissions, platformSuperUser, `${ns}.read`));
  // Deliberately no identity/name/email on this branch: a caller that needs one
  // (Sage's get_user tool) builds its own scalar identity from its own
  // requester-scoped lookup, not from here (CONTRACT.md Ruling R10).
  if (!canReadAny && !isSelfTarget) return { kind: 'notAuthorized' };

  const slugMap = await slugTagger(target.roleIds || []);
  const roleSlugs = [...slugMap.values()];
  // A cold roleRegistry caches an EMPTY registry for 60s. Reporting that as
  // notFound would tell the user a real colleague does not exist.
  if (!roleSlugs.length) return { kind: 'unavailable' };

  const nameMap = await nameTagger(target.roleIds || []);
  const profiles = {};
  const allSections = new Set();

  for (const provider of pickProviders(roleSlugs)) {
    let doc;
    try {
      doc = await provider.load(target);
    } catch {
      profiles[provider.role] = { error: true, relatedTools: provider.relatedTools ?? [] };
      continue;
    }
    const projected = projectFields(
      doc, provider.FIELDS,
      { permissions, platformSuperUser, isSelf, ns: provider.ns },
      provider.deriveFns
    );
    profiles[provider.role] = doc
      ? { ...projected, relatedTools: provider.relatedTools ?? [] }
      : { ...projected, noRecord: true, relatedTools: provider.relatedTools ?? [] };
    for (const s of projected.sections) allSections.add(s);
  }

  return {
    kind: 'unique',
    identity: {
      userId: target.userId,
      name: target.name,
      email: target.email ?? null,
      roles: [...nameMap.values()],
      roleSlugs,
    },
    profiles,
    availableSections: [...allSections],
    depth,
  };
}
