import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { taskFilters } from './filters.js';
import {
  TASKS_ACCESS, MAX_LIST_LIMIT, workScope, workDeps, buildTaskFilter, mapTaskRows, countFacts,
} from './common.js';

const SORTS = { newest: '-createdAt', dueDate: 'dueDate:asc,_id:asc' };

export default defineTool({
  name: 'list_tasks',
  domain: 'projects',
  kind: 'read',
  description:
    'List Task Board tasks: code, title, stage, priority, due date, project, sprint, assignees, creator name, ' +
    'created and last-updated times, comment count, attachment count, and the latest comment when this viewer ' +
    'can open Task Board comments. Use for "my tasks", "tasks for project X", "which tasks are overdue", ' +
    '"who created this task", "last comment", "why is this overdue", "no updates in N days", ' +
    '"today\'s task activity", "tasks with comments". total is the full count. There is no overdue-reason field.',
  measure:
    'TASK records visible on the Task Board (only your own tasks without tasks.read), every stage unless ' +
      'filters.status is set; tasks whose project was deleted are excluded.',
  input: Joi.object({
    filters: taskFilters,
    sort: Joi.string().valid('newest', 'dueDate').default('newest'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: TASKS_ACCESS,
  async execute({ filters = {}, sort = 'newest', limit = 20 } = {}, ctx) {
    const user = workScope(ctx);
    const deps = workDeps(ctx);
    const built = await buildTaskFilter(user, filters, deps);
    if (built.result) return { records: [], ...built.result, filtersApplied: filters };
    const f = built.filter;
    // Mongo sorts a missing dueDate first on an ascending sort — keep the undated backlog out.
    const filter = sort === 'dueDate' && !f.dueDate && !f.noDueDate && !f.overdue ? { ...f, hasDueDate: true } : f;
    const res = await deps.queryTasks(filter, { limit, sortBy: SORTS[sort] });
    const mapped = await mapTaskRows(res?.results || [], user, deps);
    return {
      total: res?.totalResults ?? 0,
      scope: built.scope,
      commentsVisible: mapped.commentsVisible,
      records: mapped.records,
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error || result.ambiguous) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'task-list',
      tableType: 'task-list',
      title: `Tasks (${result.total})`,
      columns: [
        { key: 'code', label: 'Code', priority: 'secondary' },
        { key: 'title', label: 'Task', priority: 'primary' },
        { key: 'status', label: 'Stage', priority: 'primary' },
        { key: 'dueDate', label: 'Due', priority: 'secondary' },
        { key: 'assignees', label: 'Assignees', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        code: r.code ?? '—',
        title: r.title ?? '—',
        status: r.status ?? '—',
        dueDate: r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : '—',
        assignees: r.assignees.join(', ') || '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: countFacts('list_tasks', 'tasks', result.total) };
  },
});
