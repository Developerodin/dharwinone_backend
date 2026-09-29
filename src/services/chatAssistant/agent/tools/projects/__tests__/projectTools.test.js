import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countProjects from '../countProjects.tool.js';
import listProjects from '../listProjects.tool.js';
import listTeams from '../listTeams.tool.js';
import countTasks from '../countTasks.tool.js';
import listTasks from '../listTasks.tool.js';
import getWorkload from '../getWorkload.tool.js';

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
    });
    assert.equal(out.scope, 'mine');
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
