import Joi from 'joi';
import mongoose from 'mongoose';
import { defineTool } from '../../defineTool.js';
import TaskModel from '../../../../../models/task.model.js';
import {
  countActiveProjectsByAssignee as realCountActiveProjects,
  isAtProjectCapacity,
  MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
} from '../../../../projectCapacity.js';
import { OPEN_TASK_STATUSES, OVERLOAD_TASK_THRESHOLD } from '../../../taskAccess.js';
import { toApiFilter } from '../../../../../schemas/employees/employeeQuery.scope.js';
import { WORKLOAD_ACCESS, MAX_LIST_LIMIT, workScope, workDeps, taskViewerScope, idOf } from './common.js';
import { personRecordsDeps } from '../employees/common.js';

const BUCKETS = [
  'projects_0', 'projects_1', 'projects_2', 'projects_3_plus', 'no_active_tasks', 'unallocated', 'overloaded',
];
const DEFAULT_OVERLOAD_ABOVE = OVERLOAD_TASK_THRESHOLD - 1; // > 9 open tasks = get_workload's "10+"

function allocationDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    ...workDeps(ctx),
    ...personRecordsDeps(ctx),
    Task: deps.Task ?? TaskModel,
    countActiveProjects: deps.countActiveProjects ?? realCountActiveProjects,
  };
}

/**
 * The Employees page's scoped population (same authorize → scope → mongo filter chain as
 * runPersonGroupBy), current employees only. ponytail: loads every scoped employee's owner/name —
 * fine to a few thousand; past that, move the bucket math into one aggregate joined on owner.
 */
async function loadPopulation(user, designation, deps) {
  const filters = { ownerUserRole: 'employee', ...(designation ? { designation } : {}) };
  const auth = deps.authorizeEmployeeQuery({ entity: 'employees', operations: ['count'], filters }, user);
  if (!auth?.allowed) return { error: auth?.error || 'You do not have permission to query employees.' };
  const apiFilter = await deps.applyEmployeeListScope(toApiFilter(filters), user, user.authContext);
  const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
  const rows = await deps.Employee.find(mongoFilter).select('fullName employeeId designation owner').lean();
  return { rows };
}

/** ownerId → open task count, org-wide (the caller only runs this for viewers who see the whole board). */
async function countOpenTasks(ownerIds, deps) {
  const oids = ownerIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
  const counts = new Map(ownerIds.map((id) => [id, 0]));
  if (!oids.length) return counts;
  const rows = await deps.Task.aggregate([
    { $match: { projectId: { $ne: null }, status: { $in: OPEN_TASK_STATUSES }, assignedTo: { $in: oids } } },
    { $unwind: '$assignedTo' },
    { $match: { assignedTo: { $in: oids } } },
    { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
  ]);
  for (const r of rows) counts.set(String(r._id), r.n);
  return counts;
}

function projectBucket(n) {
  if (n >= 3) return 'projects_3_plus';
  return `projects_${n}`;
}

function inBucket(bucket, p, overloadAbove) {
  if (bucket.startsWith('projects_')) return projectBucket(p.activeProjects) === bucket;
  if (p.openTasks == null) return false;
  if (bucket === 'no_active_tasks') return p.openTasks === 0;
  if (bucket === 'unallocated') return p.activeProjects === 0 && p.openTasks === 0;
  return p.openTasks > overloadAbove;
}

async function canAssign({ person, project }, user, deps) {
  const who = await deps.resolveAssignee(person);
  if (who.kind === 'ambiguous') return { mode: 'can_assign', ambiguous: 'person', matches: who.matches };
  if (who.kind !== 'found') return { mode: 'can_assign', notFound: 'person', searchedFor: person };
  const proj = await deps.resolveProject(project, user);
  if (proj.kind === 'ambiguous') {
    return { mode: 'can_assign', ambiguous: 'project', matches: proj.matches.map((p) => ({ id: idOf(p), name: p.name })) };
  }
  if (proj.kind !== 'found') return { mode: 'can_assign', notFound: 'project', searchedFor: project };

  const userId = String(who.userIds[0]);
  const projectId = idOf(proj.project);
  const alreadyOnProject = (proj.project.assignedTo || []).some((u) => idOf(u) === userId);
  const counts = await deps.countActiveProjects([userId], { excludeProjectId: projectId });
  const activeElsewhere = counts.get(userId) ?? 0;
  const eligible = !isAtProjectCapacity(activeElsewhere, { alreadyOnProject });
  let reason;
  if (alreadyOnProject) reason = 'Already an assignee on this project, so the limit does not apply.';
  else if (eligible) {
    reason = `On ${activeElsewhere} other active project(s) — under the limit of ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}.`;
  } else {
    reason = `Already on ${activeElsewhere} other active projects — the limit is ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}.`;
  }
  return {
    mode: 'can_assign',
    person: who.match?.name ?? person,
    project: proj.project.name ?? null,
    projectStatus: proj.project.status ?? null,
    eligible,
    reason,
    activeProjectsElsewhere: activeElsewhere,
    alreadyOnProject,
    maxActiveProjects: MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
  };
}

export default defineTool({
  name: 'get_allocation',
  domain: 'projects',
  kind: 'read',
  description:
    'Who is free / busy by ACTIVE PROJECTS (In progress or On hold, as a project assignee) and open tasks. ' +
    'mode summary: how many employees are on 0 / 1 / 2 / 3+ active projects, with no active tasks, fully ' +
    'unallocated (0 projects and 0 open tasks) and overloaded. mode list + bucket: who they are. ' +
    'mode can_assign + person + project: can this person be added to that project under the ' +
    `max-${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}-active-projects staffing rule (eligible + reason). ` +
    'designation narrows to a job title.',
  measure:
    'Current Employee profiles in the viewer\'s Employees-page scope, by the number of active projects ' +
    '(Inprogress / On hold) listing them in assignedTo and by open tasks (new, todo, on_going, in_review).',
  input: Joi.object({
    mode: Joi.string().valid('summary', 'list', 'can_assign').default('summary'),
    bucket: Joi.string().valid(...BUCKETS).description('For mode list.'),
    designation: Joi.string().min(1).max(80).description('Job title, partial match, e.g. "React Developer".'),
    overloadAbove: Joi.number().integer().min(0).max(200)
      .description(`Overloaded = more than this many open tasks. Default ${DEFAULT_OVERLOAD_ABOVE}.`),
    person: Joi.string().min(1).max(120).description('For can_assign: the person\'s real name.'),
    project: Joi.string().min(1).max(120).description('For can_assign: project name.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: WORKLOAD_ACCESS,
  async execute(args = {}, ctx) {
    const user = workScope(ctx);
    const deps = allocationDeps(ctx);
    const { mode = 'summary', bucket, designation, limit = 20 } = args;
    const overloadAbove = args.overloadAbove ?? DEFAULT_OVERLOAD_ABOVE;

    if (mode === 'can_assign') {
      if (!args.person || !args.project) return { error: 'can_assign needs person and project.' };
      return canAssign(args, user, deps);
    }
    if (mode === 'list' && !bucket) return { error: 'mode list needs bucket.' };

    const pop = await loadPopulation(user, designation, deps);
    if (pop.error) return { error: pop.error };
    const withLogin = pop.rows.filter((e) => e.owner);
    const ownerIds = withLogin.map((e) => String(e.owner));
    const { orgWide } = await taskViewerScope(user, deps);
    const [projectCounts, taskCounts] = await Promise.all([
      deps.countActiveProjects(ownerIds),
      orgWide ? countOpenTasks(ownerIds, deps) : Promise.resolve(null),
    ]);
    const people = withLogin.map((e) => ({
      id: idOf(e),
      name: e.fullName ?? null,
      employeeId: e.employeeId ?? null,
      designation: e.designation ?? null,
      activeProjects: projectCounts.get(String(e.owner)) ?? 0,
      openTasks: taskCounts ? taskCounts.get(String(e.owner)) ?? 0 : null,
    }));
    const taskNote = taskCounts ? null : 'Open-task counts need tasks.read, so task buckets are not available.';
    const common = {
      ...(designation ? { designation } : {}),
      maxActiveProjects: MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
      ...(pop.rows.length > withLogin.length ? { withoutLoginAccount: pop.rows.length - withLogin.length } : {}),
      ...(taskNote ? { note: taskNote } : {}),
    };

    if (mode === 'list') {
      if (!bucket.startsWith('projects_') && !taskCounts) return { mode, bucket, total: null, records: [], ...common };
      const hits = people.filter((p) => inBucket(bucket, p, overloadAbove))
        .sort((a, b) => (b.openTasks ?? 0) - (a.openTasks ?? 0) || String(a.name).localeCompare(String(b.name)));
      return {
        mode, bucket, total: hits.length, records: hits.slice(0, limit),
        ...(bucket === 'overloaded' ? { overloadAbove } : {}), ...common,
      };
    }

    const byActiveProjects = { 0: 0, 1: 0, 2: 0, '3+': 0 };
    for (const p of people) byActiveProjects[p.activeProjects >= 3 ? '3+' : p.activeProjects] += 1;
    const countOf = (b) => (taskCounts ? people.filter((p) => inBucket(b, p, overloadAbove)).length : null);
    return {
      mode: 'summary',
      total: people.length,
      byActiveProjects,
      atOrOverLimit: byActiveProjects[2] + byActiveProjects['3+'],
      noActiveTasks: countOf('no_active_tasks'),
      unallocated: countOf('unallocated'),
      overloaded: countOf('overloaded'),
      overloadAbove,
      ...common,
    };
  },
  render(result) {
    if (!result || result.error || result.matches || result.notFound || result.mode !== 'list') return null;
    if (typeof result.total !== 'number') return { blocks: [] };
    return {
      blocks: result.records.length ? [{
        type: 'table',
        id: 'allocation',
        tableType: 'allocation',
        title: `Allocation — ${result.bucket} (${result.total})`,
        columns: [
          { key: 'name', label: 'Name', priority: 'primary' },
          { key: 'designation', label: 'Designation', priority: 'secondary' },
          { key: 'activeProjects', label: 'Active projects', priority: 'primary' },
          { key: 'openTasks', label: 'Open tasks', priority: 'primary' },
        ],
        rows: result.records.map((r) => ({
          name: r.name ?? '—',
          designation: r.designation ?? '—',
          activeProjects: String(r.activeProjects),
          openTasks: r.openTasks == null ? '—' : String(r.openTasks),
        })),
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'get_allocation', label: 'people', total: result.total }] },
    };
  },
});
