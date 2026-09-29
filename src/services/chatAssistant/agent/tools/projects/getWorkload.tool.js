import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { WORKLOAD_ACCESS, workScope, workDeps } from './common.js';

const METRICS = [
  'most_tasks', 'overload', 'overdue_by_employee', 'employee_projects',
  'team_member_workload', 'team_workload', 'team_utilization',
];

export default defineTool({
  name: 'get_workload',
  domain: 'projects',
  kind: 'read',
  description:
    'Per-person and per-team task workload. metric: most_tasks (people ranked by open tasks), overload ' +
    '(10+ open tasks), overdue_by_employee, employee_projects (projects a person has tasks on; needs ' +
    'assigneeName), team_member_workload / team_workload / team_utilization (need teamName).',
  measure:
    'Open TASKS (new, todo, on_going, in_review) per assignee or team on the Task Board; a task with two ' +
      'assignees counts for both.',
  input: Joi.object({
    metric: Joi.string().valid(...METRICS).default('most_tasks'),
    assigneeName: Joi.string().min(1).description('Real name, never a pronoun.'),
    teamName: Joi.string().min(1),
    projectName: Joi.string().min(1),
  }),
  access: WORKLOAD_ACCESS,
  async execute({ metric = 'most_tasks', assigneeName, teamName, projectName } = {}, ctx) {
    const user = workScope(ctx);
    const deps = workDeps(ctx);
    if (metric === 'employee_projects' && !assigneeName) return { error: 'employee_projects needs assigneeName.' };
    if (metric.startsWith('team_') && !teamName) return { error: `${metric} needs teamName.` };
    const out = await deps.fetchWorkloadAnalytics({ user, args: { metric, assigneeName, teamName, projectName } });
    if (out?.forbidden) return { error: out.reason || 'Not allowed.' };
    if (out?.ambiguous) return { ambiguous: true, searchedFor: out.searchedFor, matches: out.matches };
    return {
      metric: out?.metric ?? metric,
      rows: out?.rows ?? [],
      lookup: out?.lookup ?? null,
      ...(out?.searchedFor ? { notFound: out.searchedFor } : {}),
    };
  },
});
