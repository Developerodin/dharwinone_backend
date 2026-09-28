import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { getRoles } from '../../../../../validations/role.validation.js';
import { ROLES_ACCESS, peopleScope, peopleDeps, EXCLUDE_PLATFORM_SUPER } from './common.js';

export default defineTool({
  name: 'list_roles',
  domain: 'people',
  kind: 'read',
  description:
    'List the roles defined in the system (name, aliases, status, how many active users hold each). Use ' +
    'for "what roles exist" — not user headcounts by role, which is count_users with a role filter.',
  measure:
    "ROLE definitions, every role status unless status is set; each role's userCount is ACTIVE user " +
      'accounts holding it.',
  input: Joi.object({
    status: getRoles.query.extract('status'),
  }),
  access: ROLES_ACCESS,
  async execute({ status } = {}, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);

    const rolesPage = await deps.queryRoles(status ? { status } : {}, { limit: 200 });

    // Ruling R9: a fresh aggregate matching count_users' own default scoping
    // (active, hidden-excluded, platform-super-excluded) — not queryRoles' own
    // assigneeCountTotal/assigneeCountActivePending, which lack hidden-user
    // exclusion and don't default to "active". Keeps this number in agreement
    // with count_users groupBy:'role' for the same role.
    const hiddenIds = deps.viewerSeesHiddenUsers(user) ? [] : await deps.getDirectoryHiddenUserIds();
    const rows = await deps.User.aggregate([
      {
        $match: {
          status: 'active',
          ...EXCLUDE_PLATFORM_SUPER,
          ...(hiddenIds.length ? { _id: { $nin: hiddenIds } } : {}),
        },
      },
      { $unwind: '$roleIds' },
      { $group: { _id: '$roleIds', count: { $sum: 1 } } },
    ]);
    const byRoleId = new Map(rows.map((r) => [String(r._id), r.count]));

    const roles = (rolesPage.results || []).map((r) => {
      const roleId = String(r.id ?? r._id);
      return {
        id: roleId,
        name: r.name,
        aliases: r.aliases || [],
        status: r.status,
        userCount: byRoleId.get(roleId) ?? 0,
      };
    });
    return { roles };
  },
  render(result) {
    const rows = (result.roles || []).map((r) => ({
      name: r.name,
      aliases: r.aliases.length ? r.aliases.join(', ') : '—',
      status: r.status,
      userCount: String(r.userCount),
    }));
    const block = {
      type: 'table',
      id: 'roles',
      tableType: 'roles',
      title: `Roles (${rows.length})`,
      columns: [
        { key: 'name', label: 'Name', priority: 'primary' },
        { key: 'aliases', label: 'Aliases', priority: 'secondary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'userCount', label: 'Users (active)', priority: 'primary', format: 'number' },
      ],
      rows,
      layout: 'auto',
    };
    // No count facts: a role listing isn't a single countable "N users" claim —
    // userCount is per-row, same reasoning as count_jobs' groupBy output.
    return { blocks: [block], facts: { counts: [], primary: null } };
  },
});
