// src/services/chatAssistant/personProfile/index.js

import { resolveUserEntity as realResolve } from '../entityResolver.js';
import { getUserPermissionContext as realPermCtx } from '../../permission.service.js';
import { tagRoleDisplayNames as realNames, tagRoleSlugs as realSlugs } from '../roleRegistry.js';
import { selectProviders as realSelect } from './selectProviders.js';
import { projectFields } from './fieldProjector.js';
import { writePending as realWritePending,
         writeCurrentPerson as realWriteCurrent } from './pendingPerson.js';
import { hasApiPermissionFromContext } from '../../../utils/permissionCheck.js';
import User from '../../../models/user.model.js';

const READ_NAMESPACES = ['employees', 'candidates', 'students', 'mentors', 'recruiters', 'agents'];

/** Minimal identity + roles for a caller-supplied userId. */
function realLoadUserById(id) {
  return User.findById(id).select('name email roleIds').lean();
}

/**
 * @param {object} a
 * @param {string} [a.person]         free-form name / email / employeeId
 * @param {any}    [a.userId]         pre-resolved id from the pre-router
 * @param {'brief'|'full'} [a.depth]
 * @param {object} a.viewer           req.user
 * @param {boolean} [a.impersonating] true when req.impersonation is present
 * @param {any} a.adminId
 * @param {object} [a.deps]           injection seam for tests
 */
export async function resolvePersonProfile({
  person, userId = null, depth = 'brief', viewer, impersonating = false, adminId, deps = {},
}) {
  const resolveEntity = deps.resolveUserEntity ?? realResolve;
  const permCtxOf     = deps.getUserPermissionContext ?? realPermCtx;
  const nameTagger    = deps.tagRoleDisplayNames ?? realNames;
  const slugTagger    = deps.tagRoleSlugs ?? realSlugs;
  const pickProviders = deps.selectProviders ?? realSelect;
  const savePending   = deps.writePending ?? realWritePending;
  const saveCurrent   = deps.writeCurrentPerson ?? realWriteCurrent;
  const loadUser      = deps.loadUserById ?? realLoadUserById;
  const viewerId      = viewer?.id ?? viewer?._id;

  let target;
  if (userId) {
    // Callers that already know who they mean (pending-disambiguation
    // selection, conversational entity route, person conversation state) pass
    // only an id. Load the row: without roleIds, tagRoleSlugs() below returns
    // an empty Map and every one of those turns answered kind:'unavailable'
    // ("I couldn't reach the directory just now") for every person.
    const row = await loadUser(userId);
    if (!row) return { kind: 'notFound' };
    target = {
      userId: row._id ?? userId,
      name: row.name ?? null,
      email: row.email ?? null,
      roleIds: row.roleIds || [],
    };
  } else {
    const res = await resolveEntity(person, { viewer });
    if (res.kind === 'notFound') return { kind: 'notFound' };
    if (res.kind === 'ambiguous') {
      const matches = [];
      for (const m of res.matches) {
        const names = await nameTagger(m.roleIds || []);
        matches.push({ userId: m.userId, name: m.name, roles: [...names.values()] });
      }
      await savePending({ userId: viewerId, adminId, query: person, matches });
      return { kind: 'ambiguous', matches };
    }
    target = res.match;
  }

  const { permissions } = await permCtxOf(viewer);
  const platformSuperUser = !!viewer?.platformSuperUser;
  const isSelfTarget = String(viewerId) === String(target.userId);
  // Impersonation must not satisfy self: req.user is the impersonated person, so
  // an impersonator would otherwise read orSelf fields they have no permission for.
  const isSelf = !impersonating && isSelfTarget;

  const canReadAny = READ_NAMESPACES.some((ns) =>
    hasApiPermissionFromContext(permissions, platformSuperUser, `${ns}.read`));
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

  await saveCurrent({ userId: viewerId, adminId, target });

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
