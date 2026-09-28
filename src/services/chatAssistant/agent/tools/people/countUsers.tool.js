import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { filters } from './filters.js';
import {
  PEOPLE_ACCESS, peopleScope, peopleDeps, buildUserMongoFilter, roleNamesForIds, peopleCountFacts,
} from './common.js';

const MAX_GROUPS = 25;
const NOT_SET = 'Not set';
const GROUP_LABELS = { role: 'Role', status: 'Status' };

/** Merge null/empty buckets into one "Not set", sort by count desc, keep the top 25. */
function shapeGroups(rows) {
  const byValue = new Map();
  for (const { _id, count } of rows) {
    const value = _id === null || _id === undefined || _id === '' ? NOT_SET : String(_id);
    byValue.set(value, (byValue.get(value) || 0) + count);
  }
  const all = [...byValue].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  const total = all.reduce((sum, g) => sum + g.count, 0);
  const groups = all.slice(0, MAX_GROUPS);
  const otherCount = all.slice(MAX_GROUPS).reduce((sum, g) => sum + g.count, 0);
  return { total, groups, ...(otherCount ? { otherCount } : {}) };
}

export default defineTool({
  name: 'count_users',
  domain: 'people',
  kind: 'read',
  description:
    'Count user accounts in the Users directory (logins, not Employee/Candidate profiles). Use for ' +
    '"how many users/admins/recruiters…" and for breakdowns: groupBy role or status.',
  input: Joi.object({
    filters,
    groupBy: Joi.string()
      .valid('role', 'status')
      .description(
        'Break the count down by this field. groupBy:role counts a user once per role they hold (a user ' +
          'with 2 roles is counted in both groups — say so). A user with NO role is excluded from every ' +
          'group (unlike the ungrouped total). With groupBy:role, total is the distinct user count, not ' +
          'the sum of the groups.'
      ),
  }),
  access: PEOPLE_ACCESS,
  async execute({ filters: rawFilters, groupBy } = {}, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);
    const { mongoFilter, filtersApplied } = await buildUserMongoFilter(rawFilters, { groupBy, user, deps });

    if (!groupBy) {
      return { total: await deps.User.countDocuments(mongoFilter), filtersApplied };
    }

    if (groupBy === 'status') {
      const rows = await deps.User.aggregate([
        { $match: mongoFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return { ...shapeGroups(rows), groupBy, filtersApplied };
    }

    // groupBy === 'role' — $unwind drops users with an empty roleIds array, so
    // they are silently excluded from every group (documented on the input above).
    // A user with 2 roles is counted in both role groups, so the sum of group
    // counts overstates the real user total (review fix round 1, I-3): `total`
    // here is a fresh distinct-user count on the same filter, not the sum.
    const [totalUsers, rows] = await Promise.all([
      deps.User.countDocuments(mongoFilter),
      deps.User.aggregate([
        { $match: mongoFilter },
        { $unwind: '$roleIds' },
        { $group: { _id: '$roleIds', count: { $sum: 1 } } },
      ]),
    ]);
    const names = await roleNamesForIds(rows.map((r) => r._id), { Role: deps.Role });
    const named = rows.map((r) => ({ _id: names.get(String(r._id)) ?? String(r._id), count: r.count }));
    const shaped = shapeGroups(named);
    return { ...shaped, total: totalUsers, assignmentCount: shaped.total, groupBy, filtersApplied };
  },
  render(result) {
    if (!result?.groups) {
      return { blocks: [], facts: peopleCountFacts('count_users', result?.total ?? 0) };
    }
    const rows = result.groups.map((g) => ({ value: g.value, count: String(g.count) }));
    if (result.otherCount) rows.push({ value: 'Other', count: String(result.otherCount) });
    const overlapNote = result.groupBy === 'role'
      ? ' — a user with several roles appears in each role\'s row'
      : '';
    const block = {
      type: 'table',
      id: 'user-breakdown',
      tableType: 'user-breakdown',
      title: `Users by ${GROUP_LABELS[result.groupBy].toLowerCase()} (${result.total})${overlapNote}`,
      columns: [
        { key: 'value', label: GROUP_LABELS[result.groupBy], priority: 'primary' },
        { key: 'count', label: 'Users', priority: 'primary', format: 'number' },
      ],
      rows,
      layout: 'auto',
    };
    // No count facts for a breakdown: enforceCounts would rewrite each group's
    // "N users" in the reply to the overall total.
    return { blocks: [block], facts: { counts: [], primary: null } };
  },
});
