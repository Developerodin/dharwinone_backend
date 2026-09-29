import Joi from 'joi';
import mongoose from 'mongoose';
import { defineTool } from '../../defineTool.js';
import {
  TEAMS_ACCESS, MAX_LIST_LIMIT, ACTIVE_PROJECT_STATUSES, workScope, workDeps, buildProjectQueryContext,
  summarizeTeamMembers, idOf, countFacts,
} from './common.js';

const MEMBER_TEAMS_MAX = 5;

export default defineTool({
  name: 'list_teams',
  domain: 'projects',
  kind: 'read',
  description:
    'List workforce teams (Teams page) with member counts; total answers "how many teams". includeMembers ' +
    'returns the roster ("who is in team X"). idleOnly keeps teams with no active (in progress / on hold) project.',
  measure:
    'Workforce TEAM records (TeamGroup) visible on the Teams page; member counts are active roster rows.',
  input: Joi.object({
    search: Joi.string().min(1).description('Team name (partial match).'),
    includeMembers: Joi.boolean().description(`Include each team's roster (first ${MEMBER_TEAMS_MAX} teams only).`),
    idleOnly: Joi.boolean(),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: TEAMS_ACCESS,
  async execute({ search, includeMembers, idleOnly, limit = 20 } = {}, ctx) {
    const user = workScope(ctx);
    const deps = workDeps(ctx);
    const filter = { ...buildProjectQueryContext(user), ...(search ? { search } : {}) };
    // idleOnly filters after the fetch, so pull the page's max (200) and slice.
    const res = await deps.queryTeamGroups(filter, { limit: idleOnly ? 200 : limit, sortBy: '-createdAt' });
    let teams = res?.results || [];
    let total = res?.totalResults ?? teams.length;

    if (idleOnly && teams.length) {
      const busy = new Set((await deps.Project.distinct('assignedTeams', {
        assignedTeams: { $in: teams.map((t) => t._id ?? t.id) },
        status: { $in: ACTIVE_PROJECT_STATUSES },
      })).map(String));
      teams = teams.filter((t) => !busy.has(idOf(t)));
      total = teams.length;
      teams = teams.slice(0, limit);
    }

    const ids = teams.map(idOf).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const counts = ids.length ? await deps.TeamMember.aggregate([
      { $match: { teamId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, isActive: { $ne: false } } },
      { $group: { _id: '$teamId', count: { $sum: 1 } } },
    ]) : [];
    const countById = new Map(counts.map((c) => [String(c._id), c.count]));

    const records = await Promise.all(teams.map(async (t, i) => ({
      id: idOf(t),
      name: t.name ?? null,
      department: t.department ?? null,
      memberCount: countById.get(idOf(t)) ?? 0,
      ...(includeMembers && i < MEMBER_TEAMS_MAX
        ? { members: summarizeTeamMembers(await deps.getTeamMembersByTeam(t._id ?? t.id)).map((m) => m.name) }
        : {}),
    })));
    return { total, records, ...(idleOnly ? { idleOnly: true } : {}) };
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'team-list',
      tableType: 'team-list',
      title: `Teams (${result.total})`,
      columns: [
        { key: 'name', label: 'Team', priority: 'primary' },
        { key: 'memberCount', label: 'Members', priority: 'primary' },
      ],
      rows: result.records.map((r) => ({ name: r.name ?? '—', memberCount: r.memberCount })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: countFacts('list_teams', 'teams', result.total) };
  },
});
