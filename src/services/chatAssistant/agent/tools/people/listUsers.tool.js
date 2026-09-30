import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { filters } from './filters.js';
import {
  PEOPLE_ACCESS, peopleScope, peopleDeps, buildUserMongoFilter, roleNamesForIds, peopleCountFacts,
} from './common.js';

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

function userRow(doc, roleNameMap) {
  return {
    id: String(doc._id),
    name: doc.name ?? null,
    email: doc.email ?? null,
    roles: (doc.roleIds || []).map((id) => roleNameMap.get(String(id))).filter(Boolean),
    status: doc.status ?? null,
    lastLoginAt: doc.lastLoginAt ?? null,
  };
}

export default defineTool({
  name: 'list_users',
  domain: 'people',
  kind: 'read',
  description:
    'List user accounts in the Users directory, newest first, with the total that match. Returns compact ' +
    "rows (name, email, roles, status, last login); use get_user for one person's full detail. " +
    'filters.inactiveDays / neverLoggedIn answer "who hasn\'t logged in recently / ever".',
  measure:
    'User ACCOUNTS (logins) in the Users directory, the same measure as the Users page; status active ' +
      'unless filters.status is set.',
  input: Joi.object({
    filters,
    limit: Joi.number()
      .integer()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .description(`Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). total is always the full count.`),
  }),
  access: PEOPLE_ACCESS,
  async execute({ filters: rawFilters, limit = DEFAULT_LIMIT } = {}, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);
    const { mongoFilter, filtersApplied } = await buildUserMongoFilter(rawFilters, { user, deps });

    const [total, docs] = await Promise.all([
      deps.User.countDocuments(mongoFilter),
      deps.User.find(mongoFilter)
        .select('name email status roleIds lastLoginAt')
        .sort('-createdAt')
        .limit(Math.min(limit, MAX_LIMIT))
        .lean(),
    ]);
    const allRoleIds = [...new Set(docs.flatMap((d) => (d.roleIds || []).map(String)))];
    const roleNameMap = await roleNamesForIds(allRoleIds, { Role: deps.Role });
    return { total, users: docs.map((d) => userRow(d, roleNameMap)), filtersApplied };
  },
  render(result) {
    const rows = (result.users || []).map((u) => ({
      name: u.name || '—',
      email: u.email || '—',
      roles: u.roles.length ? u.roles.join(', ') : '—',
      status: u.status || '—',
      lastLoginAt: u.lastLoginAt ?? null,
    }));
    const block = {
      type: 'table',
      id: 'users',
      tableType: 'users',
      title: `Users (${result.total})`,
      columns: [
        { key: 'name', label: 'Name', priority: 'primary' },
        { key: 'email', label: 'Email', priority: 'primary' },
        { key: 'roles', label: 'Roles', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'lastLoginAt', label: 'Last login', priority: 'secondary', format: 'date' },
      ],
      rows,
      layout: 'auto',
    };
    return { blocks: [block], facts: peopleCountFacts('list_users', result.total) };
  },
});
