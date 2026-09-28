import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { ROLES_ACCESS, peopleScope, peopleDeps, resolveRoleNames } from './common.js';

export default defineTool({
  name: 'get_role',
  domain: 'people',
  kind: 'read',
  description:
    'One role\'s definition: name, aliases, status, and its full permission list. Use for "what can a ' +
    'Sales Agent do" / "what permissions does X role have" — not user headcounts, which is count_users.',
  input: Joi.object({
    name: Joi.string().min(1).required()
      .description('Role name — exact match against its name, alias, or a former name (no partial match).'),
  }),
  access: ROLES_ACCESS,
  async execute({ name } = {}, ctx) {
    peopleScope(ctx);
    const deps = peopleDeps(ctx);

    // Same resolveRoleNames() exact-match semantics (name/slug/alias/previousName,
    // case-insensitive, any status) as the count_users/list_users role filter, so
    // "what can a Sales Agent do" and "how many sales agents" resolve the same role(s).
    const resolved = await resolveRoleNames([name], { Role: deps.Role });
    if (!resolved.ids.length) return { matches: [] };
    if (resolved.ids.length > 1) {
      const docs = await deps.Role.find({ _id: { $in: resolved.ids } }).select('name slug').lean();
      return { matches: docs.map((d) => ({ name: d.name, slug: d.slug })) };
    }

    const role = await deps.Role.findById(resolved.ids[0])
      .select('name slug aliases status permissions')
      .lean();
    if (!role) return { matches: [] };
    return {
      name: role.name,
      slug: role.slug,
      aliases: role.aliases || [],
      status: role.status,
      permissions: role.permissions || [],
    };
  },
  render(result) {
    if (!result?.name) return null;
    const pairs = [
      { label: 'Name', value: result.name },
      { label: 'Aliases', value: result.aliases.length ? result.aliases.join(', ') : '—' },
      { label: 'Status', value: result.status },
      { label: 'Permissions', value: result.permissions.length ? result.permissions.join(', ') : '—' },
    ];
    return {
      blocks: [{ type: 'kv', id: 'role-detail', title: result.name, pairs }],
      facts: { counts: [], primary: null },
    };
  },
});
