/* eslint-disable */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mockUpsert = mock.fn(async () => {});
const mockQuery = mock.fn(async () => ({
  matches: [{ id: 'student_abc', score: 0.9, metadata: { mongoId: 'abc' } }],
}));
const mockDescribeIndexStats = mock.fn(async () => ({}));
const mockDeleteMany = mock.fn(async () => {});

const mockNamespace = () => ({
  upsert: mockUpsert,
  query: mockQuery,
  deleteMany: mockDeleteMany,
});

mock.module('@pinecone-database/pinecone', {
  namedExports: {
    Pinecone: class {
      index() {
        return { namespace: mockNamespace, describeIndexStats: mockDescribeIndexStats };
      }
    },
  },
});

mock.module('../config/config.js', {
  defaultExport: { pinecone: { apiKey: 'test-key', indexName: 'dharwin-hr' } },
});

mock.module('../config/logger.js', {
  defaultExport: { warn: () => {}, info: () => {}, error: () => {} },
});

const { pineconeUpsert, pineconeQuery, pineconeDelete, pineconeHealthCheck } =
  await import('./pinecone.util.js');

beforeEach(() => {
  mockUpsert.mock.resetCalls();
  mockQuery.mock.resetCalls();
  mockDeleteMany.mock.resetCalls();
  mockDescribeIndexStats.mock.resetCalls();
});

test('pineconeUpsert calls namespace upsert with vectors', async () => {
  const vectors = [{ id: 'student_1', values: [0.1, 0.2], metadata: { adminId: 'a1', mongoId: '1' } }];
  await pineconeUpsert('students', vectors);
  assert.equal(mockUpsert.mock.calls.length, 1);
  assert.deepEqual(mockUpsert.mock.calls[0].arguments[0], vectors);
});

test('pineconeQuery returns matches array', async () => {
  const results = await pineconeQuery('students', [0.1, 0.2], 5, { adminId: 'admin1' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'student_abc');
  assert.equal(results[0].score, 0.9);
});

test('pineconeQuery throws if adminId filter missing', async () => {
  await assert.rejects(
    () => pineconeQuery('students', [0.1], 5, {}),
    /adminId filter is required/
  );
});

test('pineconeQuery throws if filter is undefined', async () => {
  await assert.rejects(
    () => pineconeQuery('students', [0.1], 5, undefined),
    /adminId filter is required/
  );
});

test('pineconeDelete calls deleteMany', async () => {
  await pineconeDelete('students', ['student_1', 'student_2']);
  assert.equal(mockDeleteMany.mock.calls.length, 1);
  assert.deepEqual(mockDeleteMany.mock.calls[0].arguments[0], ['student_1', 'student_2']);
});

test('pineconeDelete skips call on empty array', async () => {
  await pineconeDelete('students', []);
  assert.equal(mockDeleteMany.mock.calls.length, 0);
});

test('pineconeHealthCheck returns true on success', async () => {
  const result = await pineconeHealthCheck();
  assert.equal(result, true);
  assert.equal(mockDescribeIndexStats.mock.calls.length, 1);
});
