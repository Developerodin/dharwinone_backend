import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { buildProfileTableBlock } from '../../../personProfile/profileTableBlock.js';
import { peopleScope, peopleDeps, adminIdOf } from './common.js';

/**
 * The signed-in user's own profile. A separate tool from get_user on purpose: get_user needs
 * users.read, and the registry hides it from anyone without it — exactly the users who most
 * often ask "what's my employee id". Self field rules (orSelf) come from resolvePersonProfile;
 * impersonation never counts as self there.
 */
export default defineTool({
  name: 'get_my_profile',
  domain: 'people',
  kind: 'read',
  description:
    "The signed-in user's OWN profile: name, email, roles and every role-specific profile they hold " +
    '(e.g. their employee id, designation, department, joining date). Use for "my profile", "who am I", ' +
    '"my employee id / designation / joining date". Never for anyone else — that is get_user.',
  input: Joi.object({}),
  access: { note: 'self only — the viewer\'s own record; field visibility by resolvePersonProfile self rules' },
  async execute(_args, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);
    const profile = await deps.resolvePersonProfile({
      userId: String(user.id ?? user._id),
      depth: 'full',
      viewer: user,
      impersonating: !!user.__impersonating,
      adminId: adminIdOf(user),
      persist: false,
      deps: ctx.deps,
    });
    if (profile.kind !== 'unique') return { error: 'Your profile is not available right now.' };
    return {
      kind: 'unique',
      identity: profile.identity,
      profiles: profile.profiles,
      availableSections: profile.availableSections,
    };
  },
  render(result) {
    if (result?.kind !== 'unique') return null;
    const block = buildProfileTableBlock({ kind: 'unique', identity: result.identity, profiles: result.profiles || {} });
    return { blocks: block ? [block] : [] };
  },
});
