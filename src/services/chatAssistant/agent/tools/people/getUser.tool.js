import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { buildProfileTableBlock } from '../../../personProfile/profileTableBlock.js';
import {
  OBJECT_ID_RE, PEOPLE_PROFILE_ACCESS, peopleScope, peopleDeps, peopleCountFacts,
} from './common.js';
import { canSeeCandidateResume, mergeCandidateResume, redactCandidateResume } from './candidateResume.js';

const MAX_NAME_MATCHES = 10;

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

/** Safe scalar fields only — never spreads a raw doc (password/failedLoginCount/loginLockedUntil). */
function scalarIdentity(doc) {
  return { userId: String(doc._id ?? doc.id), name: doc.name ?? null, email: doc.email ?? null };
}

export default defineTool({
  name: 'get_user',
  domain: 'people',
  kind: 'read',
  description:
    "One person's full profile: their user account plus every role-specific profile they hold " +
    '(Employee, Candidate, Student, Mentor, Recruiter, Agent, Administrator), by id or name. A name ' +
    'that fits several people returns { matches } to ask which one. A candidate profile also includes ' +
    'skills, qualifications, experiences, years of experience and a resume summary — the same fields the ' +
    'Candidates page shows. Anything not on the profile is missing, not guessed.',
  input: Joi.object({
    id: Joi.string().description('User id (id/userId from an earlier list_users row).'),
    name: Joi.string().min(1).description("Person's name, email, or part of it."),
  }).or('id', 'name'),
  access: PEOPLE_PROFILE_ACCESS,
  async execute({ id, name } = {}, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);

    // Resolve to exactly one target user ourselves first, via requester-scoped
    // reads only (getUserByIdForRequester / queryUsers) — never resolvePersonProfile's
    // own free-text resolver, which writes a pending-person disambiguation pick
    // on ambiguity (review fix round 1, I-2: get_user never writes a pending pick; R14).
    // This also gives us a safe scalar identity (name/email/userId) up front, so
    // the notAuthorized branch below never has to trust resolvePersonProfile for
    // identity (review fix round 1, C-1).
    let targetDoc;
    if (id) {
      // A malformed id would throw a CastError in getUserByIdForRequester; treat
      // it as not found, same convention as get_job's jobId handling.
      if (!OBJECT_ID_RE.test(id)) return { matches: [] };
      try {
        // Ruling R6: go through the same hidden/platform-super check GET
        // /users/:userId uses, before this id is used for anything else.
        targetDoc = await deps.getUserByIdForRequester(id, user);
      } catch {
        return { matches: [] };
      }
    } else if (name) {
      // CONTRACT.md Ruling R12: queryUsers -> buildUserListMongoFilter excludes
      // only hideFromDirectory, never platformSuperUser, and applies no status
      // filter at all — so without this, a name search would surface the
      // platform-super account and deleted accounts that getUserByIdForRequester
      // (the id path, above) correctly refuses. Platform-super stays visible to
      // a platform-super viewer only (same self/platform-super exception
      // getUserByIdForRequester already makes).
      const filter = { search: name, status: { $ne: 'deleted' } };
      if (!user.platformSuperUser) filter.platformSuperUser = { $ne: true };
      const page = await deps.queryUsers(filter, { limit: MAX_NAME_MATCHES, page: 1 }, user);
      const results = page?.results || [];
      if (results.length === 0) return { matches: [] };
      if (results.length > 1) {
        // Ruling R13: queryUsers' search is partial-match, so a query like
        // "John Smith" also returns "John Smithson" — prefer a single exact
        // name/email hit over asking the model to disambiguate.
        const wanted = name.trim().toLowerCase();
        const exact = results.filter((r) =>
          (r.name || '').trim().toLowerCase() === wanted || (r.email || '').trim().toLowerCase() === wanted);
        if (exact.length === 1) {
          [targetDoc] = exact;
        } else {
          return { matches: results.map((r) => scalarIdentity(r)) };
        }
      } else {
        [targetDoc] = results;
      }
    } else {
      return { matches: [] };
    }

    const identity = scalarIdentity(targetDoc);

    const profile = await deps.resolvePersonProfile({
      userId: identity.userId,
      depth: 'full',
      viewer: user,
      impersonating: !!user.__impersonating,
      deps: ctx.deps,
    });

    if (profile.kind === 'notFound') return { matches: [] };
    if (profile.kind === 'unavailable') return { error: 'unavailable' };

    if (profile.kind === 'notAuthorized') {
      // users.read (this tool's access gate) is reachable through aliases —
      // kanban.read/tasks.read/interviews.read — that do not satisfy
      // resolvePersonProfile's own READ_NAMESPACES check. That is a real gap
      // between "can call this tool" and "can read a profile section", not a
      // bug to route around: never abort with an error (the caller asked a
      // legitimate question) and never bypass the check either. Fall back to
      // the SAFE scalar identity we already resolved ourselves above (C-1 —
      // resolvePersonProfile's notAuthorized result carries no identity, on
      // purpose) + full role definitions.
      const roles = await loadRoleDefs(identity.userId, deps);
      return {
        kind: 'unique',
        identity: { ...identity, roles: roles.map((r) => r.name) },
        roles,
        profiles: null,
        profileNote: 'not permitted',
      };
    }

    // profile.kind === 'unique'
    const roles = await loadRoleDefs(identity.userId, deps);

    let profiles = profile.profiles;
    let { availableSections } = profile;
    // Ruling R7/R8: the registry's automatic rowScope:'person' guard doesn't
    // recognize this result shape, so the Employees/Candidates row-scope check
    // must be hand-implemented here. Only employee/candidate sections are
    // gated — student/mentor/recruiter/agent/administrator have no ownership
    // scoping concept anywhere in this codebase to mirror.
    const allowedOwners = await deps.resolveRowScope(user);
    let profileNote;
    if (allowedOwners && !allowedOwners.has(identity.userId)) {
      const { employee, candidate, ...rest } = profiles;
      if (employee || candidate) profileNote = 'employee/candidate profile not visible to you';
      profiles = rest;
      // availableSections is a flat union of section names across every
      // provider (fieldProjector's section keys — 'identity', 'employment', …
      // — are shared, not role-prefixed), so it can't be filtered by string
      // match against 'employee'/'candidate'. Recompute it from the REMAINING
      // providers' own per-provider `.sections` instead — correct even when a
      // section name (e.g. 'identity') is also contributed by a provider that
      // wasn't stripped.
      if (profileNote) {
        availableSections = [...new Set(Object.values(profiles).flatMap((p) => p?.sections || []))];
      }
    }

    // Résumé fields only for a candidate profile this viewer is still allowed to see
    // (row scope already dropped employee/candidate sections they cannot open).
    if (profiles?.candidate && !profiles.candidate.error && !profiles.candidate.noRecord) {
      if (!canSeeCandidateResume(user, identity.userId)) {
        profiles = { ...profiles, candidate: redactCandidateResume(profiles.candidate) };
      } else {
        const doc = await deps.Employee.findOne({ owner: identity.userId })
          .select('skills qualifications experiences')
          .lean();
        profiles = { ...profiles, candidate: mergeCandidateResume(profiles.candidate, doc, deps.now()) };
        availableSections = [...new Set([...(availableSections || []), ...(profiles.candidate.sections || [])])];
      }
    }

    return {
      kind: 'unique',
      identity: profile.identity,
      roles,
      profiles,
      availableSections,
      ...(profileNote ? { profileNote } : {}),
    };
  },
  render(result) {
    if (result?.kind !== 'unique') return null;
    // buildProfileTableBlock accepts exactly this { kind, identity, profiles } shape.
    const block = buildProfileTableBlock({ kind: 'unique', identity: result.identity, profiles: result.profiles || {} });
    return { blocks: block ? [block] : [], facts: peopleCountFacts('get_user', 1) };
  },
});
