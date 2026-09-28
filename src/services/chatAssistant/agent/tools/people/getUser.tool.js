import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { buildProfileTableBlock } from '../../../personProfile/profileTableBlock.js';
import {
  OBJECT_ID_RE, PEOPLE_PROFILE_ACCESS, peopleScope, peopleDeps, adminIdOf, peopleCountFacts,
} from './common.js';

/**
 * Fresh, direct User.roleIds -> Role lookup — deliberately NOT
 * profile.identity.roleSlugs/roles (those come from roleRegistry's active-only,
 * 60s-cached tagger, which silently drops inactive roles). Id-based throughout:
 * `row.roleIds` are the exact Role _ids assigned to the user, so this can never
 * pick up a role via name/previousNames matching (CONTRACT.md Ruling R6; verified
 * against roleRegistry.tagRoleSlugs()/tagRoleDisplayNames(), which resolvePersonProfile
 * itself uses for provider selection — both are id-based, see CONTRACT.md addendum).
 */
async function loadRoleDefs(userId, deps) {
  const row = await deps.User.findById(userId).select('roleIds').lean();
  const roleDocs = await deps.Role.find({ _id: { $in: row?.roleIds || [] } })
    .select('name slug aliases status permissions')
    .lean();
  return roleDocs.map(({ name, slug, aliases, status, permissions }) => ({
    name, slug, aliases, status, permissions,
  }));
}

export default defineTool({
  name: 'get_user',
  domain: 'people',
  kind: 'read',
  description:
    "One person's full profile: their user account plus every role-specific profile they hold " +
    '(Employee, Candidate, Student, Mentor, Recruiter, Agent, Administrator), by id or name. A name ' +
    'that fits several people returns { matches } to ask which one.',
  input: Joi.object({
    id: Joi.string().description('User id (id/userId from an earlier list_users row).'),
    name: Joi.string().min(1).description("Person's name, email, or part of it."),
  }).or('id', 'name'),
  access: PEOPLE_PROFILE_ACCESS,
  async execute({ id, name } = {}, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);
    const adminId = adminIdOf(user);

    let targetId = null;
    if (id) {
      // A malformed id would throw a CastError in getUserByIdForRequester; treat
      // it as not found, same convention as get_job's jobId handling.
      if (!OBJECT_ID_RE.test(id)) return { matches: [] };
      try {
        // Ruling R6: go through the same hidden/platform-super check GET
        // /users/:userId uses before ever calling resolvePersonProfile with this
        // id — its own userId-path loader skips that check.
        await deps.getUserByIdForRequester(id, user);
      } catch {
        return { matches: [] };
      }
      targetId = id;
    }
    if (!targetId && !name) return { matches: [] };

    const profile = await deps.resolvePersonProfile({
      ...(targetId ? { userId: targetId } : { person: name }),
      depth: 'full',
      viewer: user,
      impersonating: !!user.__impersonating,
      adminId,
      deps: ctx.deps,
    });

    if (profile.kind === 'ambiguous') return { matches: profile.matches };
    if (profile.kind === 'notFound') return { matches: [] };
    if (profile.kind === 'unavailable') return { error: 'unavailable' };

    if (profile.kind === 'notAuthorized') {
      // users.read (this tool's access gate) is reachable through aliases —
      // kanban.read/tasks.read/interviews.read — that do not satisfy
      // resolvePersonProfile's own READ_NAMESPACES check. That is a real gap
      // between "can call this tool" and "can read a profile section", not a
      // bug to route around: never abort with an error (the caller asked a
      // legitimate question) and never bypass the check either. Fall back to
      // the user scalar identity + full role definitions only.
      const roles = await loadRoleDefs(profile.identity.userId, deps);
      return {
        kind: 'unique',
        identity: { ...profile.identity, roles: roles.map((r) => r.name) },
        roles,
        profiles: null,
        profileNote: 'not permitted',
      };
    }

    // profile.kind === 'unique'
    const roles = await loadRoleDefs(profile.identity.userId, deps);

    let profiles = profile.profiles;
    // Ruling R7/R8: the registry's automatic rowScope:'person' guard doesn't
    // recognize this result shape, so the Employees/Candidates row-scope check
    // must be hand-implemented here. Only employee/candidate sections are
    // gated — student/mentor/recruiter/agent/administrator have no ownership
    // scoping concept anywhere in this codebase to mirror.
    const allowedOwners = await deps.resolveRowScope(user);
    if (allowedOwners && !allowedOwners.has(String(profile.identity.userId))) {
      const { employee, candidate, ...rest } = profiles;
      profiles = rest;
    }

    return { kind: 'unique', identity: profile.identity, roles, profiles, availableSections: profile.availableSections };
  },
  render(result) {
    if (result?.kind !== 'unique') return null;
    // Reuses the same table builder the legacy profile path renders with — it
    // already accepts exactly this { kind, identity, profiles } shape.
    const block = buildProfileTableBlock({ kind: 'unique', identity: result.identity, profiles: result.profiles || {} });
    return { blocks: block ? [block] : [], facts: peopleCountFacts('get_user', 1) };
  },
});
