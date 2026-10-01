import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { TASK_STATUSES } from '../../../../../models/task.model.js';
import { taskFilters } from './filters.js';
import { TASKS_ACCESS, workScope, workDeps, buildTaskFilter, countWith, countFacts } from './common.js';

export default defineTool({
  name: 'count_tasks',
  domain: 'projects',
  kind: 'read',
  description:
    'Count Task Board tasks. groupBy "status" returns the stage breakdown (new / todo / on_going / in_review / ' +
    'completed) plus overdue and blocked counts. Same filters as list_tasks, including createdBy, updatedSince ' +
    '(today\'s activity), noUpdateDays and hasComments. Use for "how many tasks are in review / blocked / ' +
    'overdue", "how many tasks does X have", "how many have no updates in 7 days".',
  measure:
    'TASK records visible on the Task Board (only your own tasks without tasks.read), every stage unless ' +
      'filters.status is set; tasks whose project was deleted are excluded.',
  input: Joi.object({
    filters: taskFilters,
    groupBy: Joi.string().valid('status'),
  }),
  access: TASKS_ACCESS,
  async execute({ filters = {}, groupBy } = {}, ctx) {
    const user = workScope(ctx);
    const deps = workDeps(ctx);
    const built = await buildTaskFilter(user, filters, deps);
    if (built.result) return { ...built.result, filtersApplied: filters };
    const { filter, scope } = built;
    if (groupBy !== 'status') {
      return { total: await countWith(deps, filter), scope, filtersApplied: filters };
    }
    const [total, overdue, blocked, ...byStage] = await Promise.all([
      countWith(deps, filter),
      countWith(deps, filter, { overdue: true }),
      countWith(deps, filter, { blocked: true }),
      ...TASK_STATUSES.map((status) => countWith(deps, filter, { status })),
    ]);
    return {
      total,
      scope,
      groupBy,
      groups: TASK_STATUSES.map((value, i) => ({ value, count: byStage[i] })),
      overdue,
      blocked,
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error || result.ambiguous) return null;
    return { blocks: [], facts: countFacts('count_tasks', 'tasks', result.total) };
  },
});
