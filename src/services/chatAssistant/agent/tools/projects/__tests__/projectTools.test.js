import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countProjects from '../countProjects.tool.js';
import listProjects from '../listProjects.tool.js';
import listTeams from '../listTeams.tool.js';
import countTasks from '../countTasks.tool.js';
import listTasks from '../listTasks.tool.js';
import getWorkload from '../getWorkload.tool.js';
import getAllocation from '../getAllocation.tool.js';

const SELF = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const viewer = (perms) => ({ id: SELF, _id: SELF, roleIds: [], authContext: { permissions: new Set(perms) } });

function ctxFor(perms, overrides = {}) {
  return {
    user: viewer(perms),
    requestId: 'req-1',
    deps: {
      isAdmin: async () => false,
      queryTasks: async () => ({ results: [], totalResults: 0 }),
      queryProjects: async () => ({ results: [], totalResults: 0 }),
      queryTeamGroups: async () => ({ results: [], totalResults: 0 }),
      resolveAssignee: async () => ({ kind: 'notFound' }),
      ...overrides,
    },
  };
}

describe('count_tasks', () => {
  it('passes the viewer to queryTasks and returns the stage breakdown with overdue and blocked', async () => {
    const seen = [];
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async (filter) => {
        seen.push(filter);
        if (filter.overdue) return { totalResults: 2 };
        if (filter.blocked) return { totalResults: 1 };
        if (filter.status === 'in_review') return { totalResults: 3 };
        if (filter.status) return { totalResults: 0 };
        return { totalResults: 9 };
      },
    });
    const out = await countTasks.execute({ groupBy: 'status' }, ctx);
    assert.equal(out.total, 9);
    assert.equal(out.overdue, 2);
    assert.equal(out.blocked, 1);
    assert.equal(out.groups.find((g) => g.value === 'in_review').count, 3);
    assert.equal(out.scope, 'all');
    assert.ok(seen.every((f) => f.userId === SELF && f.apiPermissions.has('tasks.read')));
    assert.ok(seen.every((f) => !f.assignedToMe));
  });

  it('filters by a named assignee with a real assignedTo clause (B5)', async () => {
    let seen;
    const ctx = ctxFor(['tasks.read'], {
      resolveAssignee: async (name) => (name === 'Ravi Kumar' ? { kind: 'found', userIds: [OTHER] } : { kind: 'notFound' }),
      queryTasks: async (filter) => { seen = filter; return { totalResults: 4 }; },
    });
    const out = await countTasks.execute({ filters: { assigneeName: 'Ravi Kumar' } }, ctx);
    assert.equal(out.total, 4);
    assert.equal(String(seen.assignedTo), OTHER);
  });

  it('an unknown assignee is notFound, never an unfiltered count', async () => {
    let called = false;
    const ctx = ctxFor(['tasks.read'], { queryTasks: async () => { called = true; return { totalResults: 50 }; } });
    const out = await countTasks.execute({ filters: { assigneeName: 'Nobody' } }, ctx);
    assert.equal(out.notFound, 'assignee');
    assert.equal(out.total, 0);
    assert.equal(called, false);
  });

  it('without tasks.read forces My Tasks, like the Task Board route', async () => {
    let seen;
    const ctx = ctxFor([], { queryTasks: async (filter) => { seen = filter; return { totalResults: 5 }; } });
    const out = await countTasks.execute({}, ctx);
    assert.equal(out.total, 5);
    assert.equal(out.scope, 'mine');
    assert.equal(seen.assignedToMe, true);
  });

  it('without tasks.read refuses someone else\'s tasks instead of silently answering with your own', async () => {
    const ctx = ctxFor([], { resolveAssignee: async () => ({ kind: 'found', userIds: [OTHER] }) });
    const out = await countTasks.execute({ filters: { assigneeName: 'Ravi' } }, ctx);
    assert.match(out.error, /own tasks/);
  });
});

describe('list_tasks', () => {
  it('my tasks → assignedToMe and maps rows', async () => {
    let seen;
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async (filter, opts) => {
        seen = { filter, opts };
        return {
          totalResults: 1,
          results: [{
            _id: 't1', taskCode: 'T-1', title: 'Fix login', status: 'todo', tags: ['Blocked'],
            projectId: { name: 'Portal' }, assignedTo: [{ name: 'Me' }],
          }],
        };
      },
    });
    const out = await listTasks.execute({ filters: { assignedToMe: true }, sort: 'dueDate', limit: 5 }, ctx);
    assert.equal(seen.filter.assignedToMe, true);
    assert.equal(seen.filter.hasDueDate, true);
    assert.equal(seen.opts.limit, 5);
    assert.deepEqual(out.records[0], {
      id: 't1', code: 'T-1', title: 'Fix login', status: 'todo', priority: null, dueDate: null,
      project: 'Portal', sprint: null, assignees: ['Me'], blocked: true,
      createdBy: null, createdAt: null, updatedAt: null,
      createdAtUnavailable: 'Creation date is not stored on this record.',
      commentsCount: 0, lastComment: null, attachmentsCount: 0,
    });
    assert.equal(out.commentsVisible, true);
    assert.equal(out.scope, 'mine');
  });

  it('renders one card schema: Task, Stage, Due, Assignees; project stays off the card', () => {
    const rendered = listTasks.render({
      total: 1,
      records: [{
        code: 'T-1', title: 'Fix login', status: 'todo', dueDate: '2026-04-01T00:00:00.000Z',
        assignees: ['Me'], project: 'Portal',
      }],
    });
    const labels = rendered.blocks[0].columns.map((c) => c.label);
    assert.deepEqual(labels, ['Code', 'Task', 'Stage', 'Due', 'Assignees']);
    assert.equal(rendered.blocks[0].rows[0].project, undefined);
    assert.equal(rendered.blocks[0].rows[0].title, 'Fix login');
    assert.equal(rendered.blocks[0].rows[0].status, 'todo');
  });

  it('a due window becomes a whole-day dueDate range', async () => {
    let seen;
    const ctx = ctxFor(['tasks.read'], { queryTasks: async (filter) => { seen = filter; return { totalResults: 0 }; } });
    await listTasks.execute({ filters: { dueBetween: { from: '2026-09-28', to: '2026-10-04' } } }, ctx);
    assert.equal(seen.dueDate.$gte.toISOString(), '2026-09-27T18:30:00.000Z'); // IST day bounds
    assert.equal(seen.dueDate.$lte.toISOString(), '2026-10-04T18:29:59.999Z');
  });
});

describe('projects', () => {
  it('count_projects groups by status through queryProjects with the viewer', async () => {
    const ctx = ctxFor(['projects.read'], {
      queryProjects: async (filter) => {
        assert.equal(filter.userId, SELF);
        assert.equal(filter.mine, undefined);
        return { totalResults: filter.status === 'Inprogress' ? 4 : filter.status ? 1 : 6 };
      },
    });
    const out = await countProjects.execute({ groupBy: 'status' }, ctx);
    assert.equal(out.total, 6);
    assert.deepEqual(out.groups, [
      { value: 'Inprogress', count: 4 }, { value: 'On hold', count: 1 }, { value: 'completed', count: 1 },
    ]);
  });

  it('list_projects without projects.read is My Projects only', async () => {
    let seen;
    const ctx = ctxFor(['my-projects.read'], {
      queryProjects: async (filter) => {
        seen = filter;
        return { totalResults: 1, results: [{ _id: 'p1', name: 'Portal', status: 'Inprogress', assignedTeams: [{ name: 'Alpha' }] }] };
      },
    });
    const out = await listProjects.execute({ filters: { teamAssignment: 'assigned' } }, ctx);
    assert.equal(seen.mine, true);
    assert.deepEqual(seen['assignedTeams.0'], { $exists: true });
    assert.equal(out.scope, 'mine');
    assert.deepEqual(out.records[0].teams, ['Alpha']);
  });
});

describe('list_teams', () => {
  it('idleOnly drops teams with an active project and counts roster rows', async () => {
    const A = '64b0000000000000000000aa';
    const B = '64b0000000000000000000bb';
    const ctx = ctxFor(['teams.read'], {
      queryTeamGroups: async (filter) => {
        assert.equal(filter.userId, SELF);
        return { totalResults: 2, results: [{ _id: A, name: 'Alpha' }, { _id: B, name: 'Beta' }] };
      },
      Project: { distinct: async () => [A] },
      TeamMember: { aggregate: async () => [{ _id: B, count: 3 }] },
    });
    const out = await listTeams.execute({ idleOnly: true }, ctx);
    assert.equal(out.total, 1);
    assert.deepEqual(out.records.map((r) => [r.name, r.memberCount]), [['Beta', 3]]);
  });
});

describe('get_workload', () => {
  it('passes the metric and viewer to the workload backend', async () => {
    let seen;
    const ctx = ctxFor(['projects.read'], {
      fetchWorkloadAnalytics: async (arg) => { seen = arg; return { metric: 'most_tasks', rows: [{ name: 'A', openCount: 7 }] }; },
    });
    const out = await getWorkload.execute({ metric: 'most_tasks' }, ctx);
    assert.equal(seen.user.id, SELF);
    assert.equal(seen.args.metric, 'most_tasks');
    assert.equal(out.rows[0].openCount, 7);
  });

  it('team metrics need a team name', async () => {
    const out = await getWorkload.execute({ metric: 'team_utilization' }, ctxFor(['projects.read']));
    assert.match(out.error, /teamName/);
  });
});

describe('get_allocation', () => {
  const U = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
  const STAFF = [
    { _id: 'e1', fullName: 'Asha', employeeId: 'E1', designation: 'Dev', owner: U(11) },
    { _id: 'e2', fullName: 'Ravi', employeeId: 'E2', designation: 'Dev', owner: U(12) },
    { _id: 'e3', fullName: 'Meera', employeeId: 'E3', designation: 'Dev', owner: U(13) },
    { _id: 'e4', fullName: 'Kiran', employeeId: 'E4', designation: 'Dev', owner: U(14) },
    { _id: 'e5', fullName: 'NoLogin', employeeId: 'E5', designation: 'Dev', owner: null },
  ];
  const PROJECTS = { [U(11)]: 0, [U(12)]: 1, [U(13)]: 2, [U(14)]: 3 };
  const TASKS = { [U(12)]: 12, [U(13)]: 3 };

  function allocCtx(perms, extra = {}) {
    const seen = {};
    const ctx = ctxFor(perms, {
      authorizeEmployeeQuery: (query) => { seen.authQuery = query; return { allowed: true }; },
      applyEmployeeListScope: async (f, u) => { seen.scopeUser = u; return { ...f, owner: 'scoped' }; },
      buildEmployeeListMongoFilter: async (f) => ({ mongoFilter: { scopedBy: f.owner, designation: f.designation } }),
      Employee: { find: (mf) => { seen.mongoFilter = mf; return { select: () => ({ lean: async () => STAFF }) }; } },
      countActiveProjects: async (ids, opts) => {
        seen.projectCountArgs = { ids, opts };
        return new Map(ids.map((id) => [id, PROJECTS[id] ?? 0]));
      },
      Task: { aggregate: async () => Object.entries(TASKS).map(([_id, n]) => ({ _id, n })) },
      ...extra,
    });
    return { ctx, seen };
  }

  it('shares get_workload\'s access rule', () => {
    assert.deepEqual(getAllocation.access.anyOf, ['projects.read', 'projects.manage']);
  });

  it('summary: 0 / 1 / 2 / 3+ active projects, no tasks, unallocated, overloaded — Employees-page scoped', async () => {
    const { ctx, seen } = allocCtx(['projects.read', 'tasks.read']);
    const out = await getAllocation.execute({ designation: 'Dev' }, ctx);
    assert.equal(seen.scopeUser.id, SELF);
    assert.deepEqual(seen.mongoFilter, { scopedBy: 'scoped', designation: 'Dev' });
    assert.equal(seen.authQuery.filters.ownerUserRole, 'employee');
    assert.deepEqual(out.byActiveProjects, { 0: 1, 1: 1, 2: 1, '3+': 1 });
    assert.equal(out.total, 4);
    assert.equal(out.atOrOverLimit, 2);
    assert.equal(out.noActiveTasks, 2);
    assert.equal(out.unallocated, 1);
    assert.equal(out.overloaded, 1);
    assert.equal(out.withoutLoginAccount, 1);
    assert.equal(out.maxActiveProjects, 2);
  });

  it('list bucket returns names with counts; overloadAbove is "more than N open tasks"', async () => {
    const { ctx } = allocCtx(['projects.read', 'tasks.read']);
    const free = await getAllocation.execute({ mode: 'list', bucket: 'unallocated' }, ctx);
    assert.deepEqual(free.records.map((r) => r.name), ['Asha']);
    const busy = await getAllocation.execute({ mode: 'list', bucket: 'overloaded', overloadAbove: 2 }, ctx);
    assert.deepEqual(busy.records.map((r) => [r.name, r.openTasks]), [['Ravi', 12], ['Meera', 3]]);
    assert.equal(getAllocation.render(busy).facts.counts[0].total, 2);
  });

  it('without tasks.read, task counts are null (not zero) and say why', async () => {
    const { ctx } = allocCtx(['projects.read']);
    const out = await getAllocation.execute({}, ctx);
    assert.equal(out.noActiveTasks, null);
    assert.equal(out.unallocated, null);
    assert.match(out.note, /tasks\.read/);
    const list = await getAllocation.execute({ mode: 'list', bucket: 'no_active_tasks' }, ctx);
    assert.equal(list.total, null);
  });

  it('a viewer the Employees page refuses gets an error, not an unscoped list', async () => {
    const { ctx } = allocCtx(['projects.read'], { authorizeEmployeeQuery: () => ({ allowed: false, error: 'nope' }) });
    const out = await getAllocation.execute({}, ctx);
    assert.equal(out.error, 'nope');
  });

  it('can_assign applies the max-2 rule, excluding the target project', async () => {
    const P = '64b0000000000000000000ff';
    const { ctx, seen } = allocCtx(['projects.read'], {
      resolveAssignee: async () => ({ kind: 'found', userIds: [U(13)], match: { name: 'Meera' } }),
      resolveProject: async () => ({ kind: 'found', project: { _id: P, name: 'Portal', status: 'Inprogress', assignedTo: [] } }),
    });
    const out = await getAllocation.execute({ mode: 'can_assign', person: 'Meera', project: 'Portal' }, ctx);
    assert.deepEqual(seen.projectCountArgs, { ids: [U(13)], opts: { excludeProjectId: P } });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /limit is 2/);
  });

  it('can_assign: someone already on the project stays eligible; unknown project is notFound', async () => {
    const { ctx } = allocCtx(['projects.read'], {
      resolveAssignee: async () => ({ kind: 'found', userIds: [U(14)], match: { name: 'Kiran' } }),
      resolveProject: async () => ({ kind: 'found', project: { _id: 'p1', name: 'CRM', assignedTo: [{ _id: U(14) }] } }),
    });
    const on = await getAllocation.execute({ mode: 'can_assign', person: 'Kiran', project: 'CRM' }, ctx);
    assert.equal(on.eligible, true);
    assert.equal(on.alreadyOnProject, true);
    ctx.deps.resolveProject = async () => ({ kind: 'notFound' });
    const missing = await getAllocation.execute({ mode: 'can_assign', person: 'Kiran', project: 'Nope' }, ctx);
    assert.equal(missing.notFound, 'project');
  });
});
