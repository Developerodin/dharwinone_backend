import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import countProjects from '../countProjects.tool.js';
import listProjects from '../listProjects.tool.js';
import countTasks from '../countTasks.tool.js';
import listTasks from '../listTasks.tool.js';
import { istDaysAgoStart } from '../common.js';

const SELF = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const AUTHOR = '64b000000000000000000003';
const ACTIVE = '64b0000000000000000000aa';
const STALE = '64b0000000000000000000bb';
const NOW = new Date('2026-10-01T06:30:00.000Z'); // 2026-10-01 12:00 IST

const viewer = (perms, extra = {}) => ({
  id: SELF, _id: SELF, roleIds: [], authContext: { permissions: new Set(perms) }, ...extra,
});

function ctxFor(perms, overrides = {}, userExtra = {}) {
  return {
    user: viewer(perms, userExtra),
    requestId: 'req-p',
    deps: {
      isAdmin: async () => false,
      queryTasks: async () => ({ results: [], totalResults: 0 }),
      queryProjects: async () => ({ results: [], totalResults: 0 }),
      resolveAssignee: async () => ({ kind: 'notFound' }),
      now: () => NOW,
      Task: { aggregate: async () => [] },
      ...overrides,
    },
  };
}

function userFind(rows) {
  return {
    find: () => ({ select: () => ({ lean: async () => rows }) }),
  };
}

const SECRET_BODY = 'Ping priya.secret@example.com about the delay';
const SECRET_AUTHOR_EMAIL = 'asha.private@example.com';
const taskWithComment = {
  _id: '64b000000000000000000010',
  taskCode: 'DHRW-101',
  title: 'Fix login',
  status: 'todo',
  dueDate: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  commentsCount: 1,
  attachmentsCount: 2,
  createdBy: { name: 'Board User', email: 'board.user@example.com' },
  projectId: { name: 'Portal' },
  assignedTo: [{ name: 'Me' }],
  comments: [{
    content: SECRET_BODY,
    commentedBy: { name: 'Leaked Commenter', email: SECRET_AUTHOR_EMAIL },
    createdAt: '2026-09-20T10:00:00.000Z',
  }],
};

describe('task rows', () => {
  it('returns creator, times, counts and a clipped last comment for a tasks.read viewer', async () => {
    const long = `${'x'.repeat(180)} tail-that-must-be-cut`;
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async () => ({
        totalResults: 1,
        results: [{
          ...taskWithComment,
          comments: [{
            content: long,
            commentedBy: { name: 'Asha Rao', email: SECRET_AUTHOR_EMAIL },
            createdAt: '2026-09-20T10:00:00.000Z',
          }, {
            content: 'older',
            commentedBy: { name: 'Old', email: 'old@example.com' },
            createdAt: '2026-09-01T00:00:00.000Z',
          }],
        }],
      }),
    });
    const out = await listTasks.execute({}, ctx);
    assert.equal(out.commentsVisible, true);
    const row = out.records[0];
    assert.equal(row.createdBy, 'Board User');
    assert.equal(row.createdAt, '2026-08-01T00:00:00.000Z');
    assert.equal(row.updatedAt, '2026-09-20T00:00:00.000Z');
    assert.equal(row.commentsCount, 1);
    assert.equal(row.attachmentsCount, 2);
    assert.equal(row.lastComment.by, 'Asha Rao');
    assert.equal(row.lastComment.at, '2026-09-20T10:00:00.000Z');
    assert.equal(row.lastComment.text.length, 200);
    assert.equal(JSON.stringify(out).includes(SECRET_AUTHOR_EMAIL), false);
    assert.equal(JSON.stringify(out).includes('old@example.com'), false);
    assert.equal(JSON.stringify(out).includes('board.user@example.com'), false);
  });

  it('resolves an unpopulated comment author by name and does not return their email', async () => {
    const ctx = ctxFor(['tasks.read'], {
      User: userFind([{ _id: AUTHOR, name: 'Asha Rao', email: SECRET_AUTHOR_EMAIL }]),
      queryTasks: async () => ({
        totalResults: 1,
        results: [{
          _id: '64b000000000000000000010',
          title: 'Fix login',
          commentsCount: 1,
          createdBy: { name: 'Board User' },
          comments: [{ content: 'Blocked on review', commentedBy: AUTHOR, createdAt: '2026-09-20T10:00:00.000Z' }],
        }],
      }),
    });
    const out = await listTasks.execute({}, ctx);
    assert.equal(out.records[0].lastComment.by, 'Asha Rao');
    assert.equal(out.records[0].lastComment.text, 'Blocked on review');
    assert.equal(JSON.stringify(out).includes(SECRET_AUTHOR_EMAIL), false);
  });

  it('uses the author email as by only when the comment API viewer has no name to show', async () => {
    const ctx = ctxFor(['kanban.read'], {
      queryTasks: async () => ({
        totalResults: 1,
        results: [{
          _id: '64b000000000000000000010',
          title: 'Fix login',
          commentsCount: 1,
          comments: [{
            content: 'Noted',
            commentedBy: { email: SECRET_AUTHOR_EMAIL },
            createdAt: '2026-09-20T10:00:00.000Z',
          }],
        }],
      }),
    });
    const out = await listTasks.execute({}, ctx);
    assert.equal(out.commentsVisible, true);
    assert.equal(out.records[0].lastComment.by, SECRET_AUTHOR_EMAIL);
  });

  it('hides comment text, author names and emails from a viewer the comment API would refuse', async () => {
    const ctx = ctxFor([], {
      queryTasks: async () => ({ totalResults: 1, results: [taskWithComment] }),
    });
    const out = await listTasks.execute({}, ctx);
    assert.equal(out.scope, 'mine');
    assert.equal(out.commentsVisible, false);
    assert.equal(out.records[0].lastComment, null);
    assert.equal(out.records[0].commentsCount, 1);
    assert.equal(out.records[0].createdBy, 'Board User');
    const blob = JSON.stringify(out);
    assert.equal(blob.includes('priya.secret@example.com'), false);
    assert.equal(blob.includes(SECRET_AUTHOR_EMAIL), false);
    assert.equal(blob.includes('Leaked Commenter'), false);
    assert.equal(blob.includes('board.user@example.com'), false);
  });

  it('tasks.manage sees the org board but not comment bodies (the comment route requires tasks.read)', async () => {
    let seen;
    const ctx = ctxFor(['tasks.manage'], {
      queryTasks: async (filter) => {
        seen = filter;
        return { totalResults: 1, results: [taskWithComment] };
      },
    });
    const out = await listTasks.execute({}, ctx);
    assert.equal(out.scope, 'all');
    assert.equal(seen.assignedToMe, undefined);
    assert.equal(out.commentsVisible, false);
    assert.equal(out.records[0].lastComment, null);
    assert.equal(JSON.stringify(out).includes('priya.secret@example.com'), false);
  });

  it('an Administrator-by-name without tasks.read is org-wide and still cannot see comments', async () => {
    const ctx = ctxFor([], { isAdmin: async () => true }, {});
    ctx.deps.queryTasks = async () => ({ totalResults: 1, results: [taskWithComment] });
    const out = await listTasks.execute({}, ctx);
    assert.equal(out.scope, 'all');
    assert.equal(out.commentsVisible, false);
    assert.equal(JSON.stringify(out).includes('Leaked Commenter'), false);
  });

  it('missing creator, dates and comments are null, not guessed', async () => {
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async () => ({
        totalResults: 1,
        results: [{ _id: '64b000000000000000000010', title: 'Bare', status: 'new' }],
      }),
    });
    const out = await listTasks.execute({}, ctx);
    const row = out.records[0];
    assert.equal(row.createdBy, null);
    assert.equal(row.createdAt, null);
    assert.match(row.createdAtUnavailable, /not stored/);
    assert.equal(row.updatedAt, null);
    assert.equal(row.lastComment, null);
    assert.equal(row.commentsCount, 0);
    assert.equal(row.attachmentsCount, 0);
  });
});

describe('task createdAt', () => {
  it('reads createdAt from the task document and does not use updatedAt', async () => {
    const id = '64b000000000000000000010';
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async () => ({
        totalResults: 1,
        results: [{ _id: id, title: 'Setup', status: 'new', updatedAt: '2026-09-15T00:00:00.000Z' }],
      }),
      Task: {
        aggregate: async () => [],
        find: () => ({
          select: () => ({
            lean: async () => [{
              _id: id,
              createdAt: new Date('2026-01-02T00:00:00.000Z'),
              updatedAt: new Date('2026-09-15T00:00:00.000Z'),
            }],
          }),
        }),
      },
    });
    const row = (await listTasks.execute({}, ctx)).records[0];
    assert.equal(row.createdAt, '2026-01-02T00:00:00.000Z');
    assert.equal(row.updatedAt, '2026-09-15T00:00:00.000Z');
    assert.equal(row.createdAtUnavailable, undefined);
  });

  it('says the creation date is unavailable when the document has no createdAt', async () => {
    const id = '64b000000000000000000011';
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async () => ({
        totalResults: 1,
        results: [{ _id: id, title: 'Setup', updatedAt: '2026-09-15T00:00:00.000Z' }],
      }),
      Task: {
        aggregate: async () => [],
        find: () => ({
          select: () => ({
            lean: async () => [{ _id: id, createdAt: null, updatedAt: new Date('2026-09-15T00:00:00.000Z') }],
          }),
        }),
      },
    });
    const row = (await listTasks.execute({}, ctx)).records[0];
    assert.equal(row.createdAt, null);
    assert.match(row.createdAtUnavailable, /not stored/);
    assert.equal(row.updatedAt, '2026-09-15T00:00:00.000Z');
  });

  it('keeps createdAt distinct from updatedAt, last activity and due date, and ignores a mismatched id', async () => {
    const id = '64b000000000000000000010';
    const other = '64b000000000000000000099';
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async () => ({
        results: [{
          _id: id,
          title: 'Setup',
          status: 'new',
          dueDate: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
        }],
      }),
      Task: {
        find: () => ({
          select: () => ({
            lean: async () => [
              { _id: other, createdAt: new Date('2026-09-15T00:00:00.000Z'), updatedAt: new Date('2026-09-15T00:00:00.000Z') },
              {
                _id: id,
                createdAt: new Date('2026-01-02T00:00:00.000Z'),
                updatedAt: new Date('2026-09-15T00:00:00.000Z'),
              },
            ],
          }),
        }),
      },
    });
    const row = (await listTasks.execute({}, ctx)).records[0];
    assert.equal(row.createdAt, '2026-01-02T00:00:00.000Z');
    assert.equal(row.updatedAt, '2026-09-15T00:00:00.000Z');
    assert.equal(row.dueDate, '2026-10-01T00:00:00.000Z');
    assert.notEqual(row.createdAt, row.updatedAt);
    assert.notEqual(row.createdAt, row.dueDate);
  });
});

describe('task filters', () => {
  it('createdBy resolves a name to an id, and an unknown creator is notFound', async () => {
    let seen;
    const ctx = ctxFor(['tasks.read'], {
      resolveAssignee: async (name) => (name === 'Ravi Kumar' ? { kind: 'found', userIds: [OTHER] } : { kind: 'notFound' }),
      queryTasks: async (filter) => { seen = filter; return { totalResults: 2 }; },
    });
    const out = await countTasks.execute({ filters: { createdBy: 'Ravi Kumar' } }, ctx);
    assert.equal(out.total, 2);
    assert.equal(seen.createdBy, OTHER);
    let called = false;
    const miss = ctxFor(['tasks.read'], {
      queryTasks: async () => { called = true; return { totalResults: 9 }; },
    });
    const none = await countTasks.execute({ filters: { createdBy: 'Nobody' } }, miss);
    assert.equal(none.notFound, 'creator');
    assert.equal(called, false);
  });

  it('without tasks.read, createdBy still forces My Tasks so other people\'s rows stay out of scope', async () => {
    let seen;
    const ctx = ctxFor([], {
      resolveAssignee: async () => ({ kind: 'found', userIds: [OTHER] }),
      queryTasks: async (filter) => { seen = filter; return { totalResults: 0, results: [] }; },
    });
    const out = await listTasks.execute({ filters: { createdBy: 'Ravi Kumar' } }, ctx);
    assert.equal(out.scope, 'mine');
    assert.equal(seen.assignedToMe, true);
    assert.equal(seen.createdBy, OTHER);
  });

  it('updatedSince is the start of that IST day and noUpdateDays is the IST day N days ago', async () => {
    let seen;
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async (filter) => { seen = filter; return { totalResults: 0 }; },
    });
    await listTasks.execute({ filters: { updatedSince: '2026-10-01' } }, ctx);
    assert.equal(seen.updatedAt.$gte.toISOString(), '2026-09-30T18:30:00.000Z');
    await countTasks.execute({ filters: { noUpdateDays: 7 } }, ctx);
    assert.equal(seen.updatedAt.$lt.toISOString(), istDaysAgoStart(7, NOW).toISOString());
    assert.equal(seen.updatedAt.$lt.toISOString(), '2026-09-23T18:30:00.000Z');
  });

  it('hasComments true and false become commentsCount clauses', async () => {
    const seen = [];
    const ctx = ctxFor(['tasks.read'], {
      queryTasks: async (filter) => { seen.push(filter); return { totalResults: 1 }; },
    });
    await countTasks.execute({ filters: { hasComments: true } }, ctx);
    await listTasks.execute({ filters: { hasComments: false } }, ctx);
    assert.deepEqual(seen[0].commentsCount, { $gt: 0 });
    assert.deepEqual(seen[1].commentsCount, { $not: { $gt: 0 } });
  });

  it('rejects a zero noUpdateDays at the schema, before a query', () => {
    const { error } = listTasks.input.validate({ filters: { noUpdateDays: 0 } });
    assert.ok(error);
  });
});

describe('project rows', () => {
  it('returns creator, clipped description, member names and lastActivityAt from one aggregation', async () => {
    const pid = STALE;
    let pipelines = 0;
    let match;
    const ctx = ctxFor(['projects.read'], {
      Task: {
        aggregate: async (pipeline) => {
          pipelines += 1;
          match = pipeline[0].$match;
          return [{ _id: new mongoose.Types.ObjectId(pid), lastActivityAt: new Date('2026-09-15T00:00:00.000Z') }];
        },
      },
      queryProjects: async () => ({
        totalResults: 1,
        results: [{
          _id: pid,
          name: 'Portal',
          status: 'Inprogress',
          createdBy: { name: 'Priya Shah', email: 'priya.secret@example.com' },
          description: `<p>${'d'.repeat(350)}</p>`,
          assignedTo: [{ name: 'Asha Rao', email: 'asha.private@example.com' }, { email: 'noname@example.com' }],
          assignedTeams: [{ name: 'Alpha' }],
        }],
      }),
    });
    const out = await listProjects.execute({}, ctx);
    assert.equal(pipelines, 1);
    assert.ok(match.projectId.$in[0] instanceof mongoose.Types.ObjectId);
    assert.equal(String(match.projectId.$in[0]), pid);
    const row = out.records[0];
    assert.equal(row.createdBy, 'Priya Shah');
    assert.equal(row.description.length, 300);
    assert.equal(row.description.includes('<p>'), false);
    assert.deepEqual(row.members, ['Asha Rao']);
    assert.equal(row.lastActivityAt, '2026-09-15T00:00:00.000Z');
    const blob = JSON.stringify(out);
    assert.equal(blob.includes('priya.secret@example.com'), false);
    assert.equal(blob.includes('asha.private@example.com'), false);
    assert.equal(blob.includes('noname@example.com'), false);
  });

  it('null description, creator and lastActivityAt when the project stores none', async () => {
    const ctx = ctxFor(['projects.read'], {
      queryProjects: async () => ({
        totalResults: 1,
        results: [{ _id: STALE, name: 'Empty', status: 'Inprogress' }],
      }),
    });
    const out = await listProjects.execute({}, ctx);
    assert.equal(out.records[0].createdBy, null);
    assert.equal(out.records[0].description, null);
    assert.deepEqual(out.records[0].members, []);
    assert.equal(out.records[0].lastActivityAt, null);
    assert.equal(out.records[0].createdAt, null);
    assert.match(out.records[0].createdAtUnavailable, /not stored/);
    assert.equal(listProjects.render(out).blocks[0].rows[0].createdAt, 'unavailable');
  });

  it('uses the document createdAt and does not substitute lastActivityAt', async () => {
    const pid = STALE;
    const ctx = ctxFor(['projects.read'], {
      Task: {
        aggregate: async () => [
          { _id: new mongoose.Types.ObjectId(pid), lastActivityAt: new Date('2026-09-15T00:00:00.000Z') },
        ],
      },
      queryProjects: async () => ({
        totalResults: 1,
        results: [{
          _id: pid,
          name: 'Portal',
          status: 'Inprogress',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          updatedAt: new Date('2026-09-15T00:00:00.000Z'),
          endDate: new Date('2026-12-01T00:00:00.000Z'),
          assignedTeams: [],
        }],
      }),
    });
    const out = await listProjects.execute({}, ctx);
    const row = out.records[0];
    assert.equal(row.createdAt, '2026-01-02T00:00:00.000Z');
    assert.equal(row.lastActivityAt, '2026-09-15T00:00:00.000Z');
    assert.notEqual(row.createdAt, row.lastActivityAt);
    assert.equal(row.endDate.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.notEqual(row.createdAt, row.endDate.toISOString());
    assert.notEqual(row.createdAt, '2026-09-15T00:00:00.000Z');
    assert.equal(listProjects.render(out).blocks[0].rows[0].createdAt, '2026-01-02T00:00:00.000Z');
    assert.equal(listProjects.render(out).blocks[0].columns.find((c) => c.key === 'createdAt').label, 'Created');
  });

  it('inactiveDays excludes projects with a task update inside the window, using one aggregation', async () => {
    let pipelines = 0;
    let seen;
    const ctx = ctxFor(['projects.read'], {
      Task: {
        aggregate: async () => {
          pipelines += 1;
          return [
            { _id: new mongoose.Types.ObjectId(ACTIVE), lastActivityAt: new Date('2026-09-30T00:00:00.000Z') },
            { _id: new mongoose.Types.ObjectId(STALE), lastActivityAt: new Date('2026-09-01T00:00:00.000Z') },
          ];
        },
      },
      queryProjects: async (filter) => {
        seen = filter;
        return {
          totalResults: 1,
          results: [{ _id: STALE, name: 'Quiet', status: 'Inprogress' }],
        };
      },
    });
    const out = await listProjects.execute({ filters: { inactiveDays: 7 } }, ctx);
    assert.equal(pipelines, 1);
    assert.deepEqual(seen._id.$nin.map(String), [ACTIVE]);
    assert.equal(out.records[0].lastActivityAt, '2026-09-01T00:00:00.000Z');
  });

  it('without projects.read the new fields stay on My Projects rows only', async () => {
    let seen;
    const ctx = ctxFor(['my-projects.read'], {
      queryProjects: async (filter) => {
        seen = filter;
        return {
          totalResults: 1,
          results: [{ _id: STALE, name: 'Mine', createdBy: { name: 'Me' }, description: 'Mine only' }],
        };
      },
    });
    const out = await listProjects.execute({}, ctx);
    assert.equal(seen.mine, true);
    assert.equal(out.scope, 'mine');
    assert.equal(out.records[0].createdBy, 'Me');
    assert.equal(out.records[0].description, 'Mine only');
  });

  it('count_projects honors inactiveDays with the same exclusion', async () => {
    let seen;
    const ctx = ctxFor(['projects.read'], {
      Task: {
        aggregate: async () => [
          { _id: new mongoose.Types.ObjectId(ACTIVE), lastActivityAt: new Date('2026-09-30T00:00:00.000Z') },
        ],
      },
      queryProjects: async (filter) => { seen = filter; return { totalResults: 3 }; },
    });
    const out = await countProjects.execute({ filters: { inactiveDays: 7 } }, ctx);
    assert.equal(out.total, 3);
    assert.deepEqual(seen._id.$nin.map(String), [ACTIVE]);
  });
});
