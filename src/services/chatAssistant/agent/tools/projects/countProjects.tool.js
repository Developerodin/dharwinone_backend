import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { projectFilters } from './filters.js';
import { PROJECTS_ACCESS, workScope, workDeps, projectFilterFor, countFacts } from './common.js';

const GROUP_VALUES = {
  status: ['Inprogress', 'On hold', 'completed'],
  priority: ['low', 'medium', 'high', 'urgent'],
  teamAssignment: ['assigned', 'unassigned'],
};

export default defineTool({
  name: 'count_projects',
  domain: 'projects',
  kind: 'read',
  description:
    'Count projects the user can see on the Projects page, optionally grouped by status, priority or ' +
    'teamAssignment (with / without a workforce team). Use for "how many projects", "how many active projects".',
  measure:
    'PROJECT records visible on the Projects page (My Projects only without projects.read), every status ' +
      'unless filters.status is set.',
  input: Joi.object({
    filters: projectFilters,
    groupBy: Joi.string().valid('status', 'priority', 'teamAssignment'),
  }),
  access: PROJECTS_ACCESS,
  async execute({ filters = {}, groupBy } = {}, ctx) {
    const user = workScope(ctx);
    const deps = workDeps(ctx);
    const countFor = async (f) => {
      const { filter, scope } = await projectFilterFor(user, f, deps);
      const res = await deps.queryProjects(filter, { limit: 1 });
      return { total: res?.totalResults ?? 0, scope };
    };
    const { total, scope } = await countFor(filters);
    if (!groupBy) return { total, scope, filtersApplied: filters };
    const groups = await Promise.all(GROUP_VALUES[groupBy].map(async (value) => ({
      value, count: (await countFor({ ...filters, [groupBy]: value })).total,
    })));
    return { total, scope, groupBy, groups, filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: countFacts('count_projects', 'projects', result.total) };
  },
});
