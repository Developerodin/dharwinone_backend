import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { projectFilters } from './filters.js';
import {
  PROJECTS_ACCESS, MAX_LIST_LIMIT, workScope, workDeps, projectFilterFor, projectRow,
  activityForProjects, idOf, countFacts,
} from './common.js';

export default defineTool({
  name: 'list_projects',
  domain: 'projects',
  kind: 'read',
  description:
    'List projects with status, priority, createdAt (when the project record was created — never ' +
    'lastActivityAt or updatedAt; if createdAt is null, say the creation date is unavailable), project ' +
    'manager, creator name, description, members (people assigned to the project), workforce teams and ' +
    'lastActivityAt (latest task update, not the creation date). Use for ' +
    '"list projects", "who created project X", "what is project X about", "who is on project X", ' +
    '"projects with no activity in N days". total is the full count.',
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
    const { filter, scope, activityById } = await projectFilterFor(user, filters, deps);
    const res = await deps.queryProjects(filter, { limit, sortBy: 'createdAt:desc' });
    const results = res?.results || [];
    const activity = activityById || await activityForProjects(results.map(idOf), deps);
    return {
      total: res?.totalResults ?? 0,
      scope,
      records: results.map((p) => projectRow(p, activity.get(String(idOf(p))) ?? null)),
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
        { key: 'createdAt', label: 'Created', priority: 'secondary', format: 'date' },
        { key: 'teams', label: 'Teams', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        name: r.name ?? '—',
        status: r.status ?? '—',
        priority: r.priority ?? '—',
        createdAt: r.createdAt ?? 'unavailable',
        teams: r.teams.join(', ') || '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: countFacts('list_projects', 'projects', result.total) };
  },
});
