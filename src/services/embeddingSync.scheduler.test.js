/* eslint-disable */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies ─────────────────────────────────────────────────────────
const mockPineconeUpsert = mock.fn(async () => {});

mock.module('../utils/pinecone.util.js', {
  namedExports: {
    pineconeUpsert: mockPineconeUpsert,
    pineconeDelete: mock.fn(async () => {}),
  },
});

mock.module('../utils/embedding.util.js', {
  namedExports: {
    embedTexts: mock.fn(async (texts) => texts.map(() => Array(1536).fill(0.1))),
  },
});

// Students: s1 has valid user+adminId, s2 has orphaned user (no adminId resolution)
mock.module('../models/student.model.js', {
  defaultExport: {
    countDocuments: mock.fn(async () => 2),
    find: mock.fn(() => ({
      skip: mock.fn(() => ({
        limit: mock.fn(() => ({
          lean: mock.fn(async () => [
            { _id: 's1', user: 'user1', skills: ['React'], experience: [] },
            { _id: 's2', user: 'orphaned_user', skills: ['Python'], experience: [] },
          ]),
        })),
      })),
    })),
    schema: { post: mock.fn() },
  },
});

// User lookup: user1 resolves to adminId='admin1'; orphaned_user absent → no adminId
mock.module('../models/user.model.js', {
  defaultExport: {
    find: mock.fn(async () => [{ _id: 'user1', adminId: 'admin1', name: 'Alice' }]),
    findById: mock.fn(async () => null),
  },
});

mock.module('../models/job.model.js', {
  defaultExport: {
    countDocuments: mock.fn(async () => 0),
    find: mock.fn(() => ({
      skip: mock.fn(() => ({ limit: mock.fn(() => ({ lean: mock.fn(async () => []) })) })),
    })),
    schema: { post: mock.fn() },
  },
});

mock.module('../models/employee.model.js', {
  defaultExport: {
    countDocuments: mock.fn(async () => 0),
    find: mock.fn(() => ({
      skip: mock.fn(() => ({ limit: mock.fn(() => ({ lean: mock.fn(async () => []) })) })),
    })),
    schema: { post: mock.fn() },
  },
});

mock.module('../config/logger.js', {
  defaultExport: { info: () => {}, warn: () => {}, error: () => {} },
});

const { runEmbeddingBackfill } = await import('./embeddingSync.scheduler.js');

// ── Tests ─────────────────────────────────────────────────────────────────────

test('backfill: orphaned student (user has no adminId) is silently skipped', async () => {
  mockPineconeUpsert.mock.resetCalls();
  await runEmbeddingBackfill();

  // 2 students but only 1 valid — s2 orphaned because its user is absent from User lookup
  assert.equal(mockPineconeUpsert.mock.calls.length, 1);
  const vectors = mockPineconeUpsert.mock.calls[0].arguments[1];
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].id, 'student_s1');
});

test('backfill: upserted vector has correct metadata shape', async () => {
  mockPineconeUpsert.mock.resetCalls();
  await runEmbeddingBackfill();

  const vector = mockPineconeUpsert.mock.calls[0].arguments[1][0];
  assert.equal(vector.metadata.adminId, 'admin1');
  assert.equal(vector.metadata.mongoId, 's1');
  assert.equal(typeof vector.metadata.isActive, 'boolean');
  assert.equal(vector.values.length, 1536);
});

test('backfill: namespace passed to pineconeUpsert is "students"', async () => {
  mockPineconeUpsert.mock.resetCalls();
  await runEmbeddingBackfill();

  const namespace = mockPineconeUpsert.mock.calls[0].arguments[0];
  assert.equal(namespace, 'students');
});
