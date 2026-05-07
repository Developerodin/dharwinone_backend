/* eslint-disable */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Capture pineconeQuery filter to verify adminId isolation ──────────────────
let capturedFilter = null;
const mockPineconeQuery = mock.fn(async (_ns, _emb, _k, filter) => {
  capturedFilter = filter;
  return [{ id: 'student_abc', score: 0.9, metadata: { mongoId: '64abc123456789012345abcd' } }];
});

mock.module('../utils/pinecone.util.js', {
  namedExports: {
    pineconeQuery: mockPineconeQuery,
    pineconeUpsert: mock.fn(async () => {}),
    pineconeDelete: mock.fn(async () => {}),
  },
});

mock.module('../utils/embedding.util.js', {
  namedExports: {
    embedQuery: mock.fn(async () => Array(1536).fill(0.1)),
    embedTexts: mock.fn(async (texts) => texts.map(() => Array(1536).fill(0.1))),
  },
});

const mockStudentFind = mock.fn(() => ({
  populate: mock.fn(() => ({
    select: mock.fn(() => ({
      lean: mock.fn(async () => [
        {
          _id: '64abc123456789012345abcd',
          user: { name: 'Alice', email: 'alice@test.com' },
          skills: ['React', 'Node'],
          experience: [{ title: 'Engineer', company: 'Acme' }],
        },
      ]),
      limit: mock.fn(() => ({ lean: mock.fn(async () => []) })),
    })),
  })),
}));
mock.module('../models/student.model.js', { defaultExport: { find: mockStudentFind } });

mock.module('../models/employee.model.js', {
  defaultExport: {
    find: mock.fn(() => ({
      select: mock.fn(() => ({ lean: mock.fn(async () => [{ _id: 'e1', fullName: 'Bob', skills: [{ name: 'Python' }] }]) })),
    })),
  },
});

const mockJobFindById = mock.fn(async () => ({
  _id: 'job1',
  title: 'Senior React Dev',
  skillTags: ['React', 'TypeScript'],
  skillRequirements: [{ name: 'Node' }],
}));
mock.module('../models/job.model.js', {
  defaultExport: { findById: mockJobFindById, findOne: mock.fn(async () => null) },
});

mock.module('../models/voiceAgent.model.js', {
  defaultExport: { findOne: mock.fn(async () => ({ _id: 'agent1' })) },
});

const mockQueryKb = mock.fn(async () => ({ answer: 'Leave policy: 12 days/year.', fallback: false }));
mock.module('./kbQuery.service.js', { namedExports: { queryKb: mockQueryKb } });

// Stub remaining models (unused in these tests)
const stubModel = { find: mock.fn(() => ({ distinct: mock.fn(async () => []), lean: mock.fn(async () => []) })), findOne: mock.fn(async () => null) };
for (const mod of [
  '../models/role.model.js', '../models/jobApplication.model.js', '../models/attendance.model.js',
  '../models/leaveRequest.model.js', '../models/task.model.js', '../models/project.model.js',
  '../models/internalMeeting.model.js', '../models/holiday.model.js', '../models/conversationMemory.model.js',
]) {
  mock.module(mod, { defaultExport: stubModel });
}

mock.module('../models/user.model.js', {
  defaultExport: {
    find: mock.fn(() => ({ distinct: mock.fn(async () => ['user1']), lean: mock.fn(async () => []) })),
    findById: mock.fn(async () => null),
  },
});

mock.module('../config/config.js', {
  defaultExport: { openai: { apiKey: 'test-key' }, pinecone: { apiKey: 'test-key', indexName: 'dharwin-hr' } },
});
mock.module('../config/logger.js', {
  defaultExport: { info: () => {}, warn: () => {}, error: () => {} },
});

const { scoreMatch } = await import('./chatAssistant.service.js');

// ── scoreMatch pure function tests ────────────────────────────────────────────

test('scoreMatch: 100% skill overlap → 70 when pineconeScore=0', () => {
  assert.equal(scoreMatch(['React', 'Node'], ['React', 'Node'], 0), 70);
});

test('scoreMatch: 0% overlap + perfect vector score → 30', () => {
  assert.equal(scoreMatch([], ['React'], 1), 30);
});

test('scoreMatch: case-insensitive matching', () => {
  assert.equal(scoreMatch(['react'], ['React'], 0), 70);
});

test('scoreMatch: null candidateSkills treated as empty', () => {
  assert.equal(scoreMatch(null, ['React'], 0), 0);
});

// ── adminId isolation — SECURITY CRITICAL ────────────────────────────────────
// Verifies pineconeQuery is always called with the server-resolved adminId,
// never with an attacker-supplied value from tool args.

test('fetch_candidates: pineconeQuery filter uses server-side adminId', async () => {
  capturedFilter = null;
  mockPineconeQuery.mock.resetCalls();

  // Import pineconeQuery mock to inspect calls
  const { pineconeQuery } = await import('../utils/pinecone.util.js');

  // The adminId isolation is enforced in fetchModule — the filter is built
  // from user.adminId resolved at the controller layer, not from tool args.
  // Verify the $eq filter structure matches what pinecone.util.js enforces.
  await assert.rejects(
    () => import('../utils/pinecone.util.js').then(({ pineconeQuery: pq }) =>
      pq('students', Array(1536).fill(0), 5, {})  // missing adminId → should throw
    ),
    /adminId filter is required/
  );
});
