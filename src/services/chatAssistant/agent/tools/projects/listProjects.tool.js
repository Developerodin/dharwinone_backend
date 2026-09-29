import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { projectFilters } from './filters.js';
import {
  PROJECTS_ACCESS, MAX_LIST_LIMIT, workScope, workDeps, projectFilterFor, projectRow, countFacts,
} from './common.js';

export default defineTool({
  name: 'list_projects',
  domain: 'projects',
  kind: 'read',
  description:
    'List projects with status, priority, dates, project manager and assigned workforce teams, newest first. ' +
    'Use for "list projects", "which team is on project X", "projects without a team". total is the full count.',
  measure:
    'PROJECT records visible on the Projects page (My Projects only without projects.read), every status ' +
      'unless filters.status is set.',
  input: Joi.object({
    filters: projectFilters,
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: PROJECTS_ACCESS,
  async execute({ filters = {}, limit = 20 } = {}, ctx) {
    const user = workScope(ctx);
    const deps = workDeps(ctx);
    const { filter, scope } = await projectFilterFor(user, filters, deps);
    const res = await deps.queryProjects(filter, { limit, sortBy: 'createdAt:desc' });
    return {
      total: res?.totalResults ?? 0,
      scope,
      records: (res?.results || []).map(projectRow),
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'project-list',
      tableType: 'project-list',
      title: `Projects (${result.total})`,
      columns: [
        { key: 'name', label: 'Project', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'priority', label: 'Priority', priority: 'secondary' },
        { key: 'teams', label: 'Teams', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        name: r.name ?? '—', status: r.status ?? '—', priority: r.priority ?? '—', teams: r.teams.join(', ') || '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: countFacts('list_projects', 'projects', result.total) };
  },
});
