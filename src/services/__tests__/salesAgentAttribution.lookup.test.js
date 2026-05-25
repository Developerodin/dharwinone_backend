import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSalesAgent } from '../salesAgentAttribution.service.js';
import { mockFindOne } from './helpers/mockMongooseQuery.js';

test('returns null when no rows exist', async () => {
  const mock = { findOne: mockFindOne({ direct: null, onSort: null }) };
  const result = await currentSalesAgent('cand1', 'job1', { Model: mock });
  assert.equal(result, null);
});

test('returns job-specific row when present', async () => {
  const expected = { salesAgentUserId: 'agent1' };
  const mock = {
    findOne: mockFindOne({
      direct: null,
      onSort: (filter) => (filter.jobId === 'job1' ? expected : null),
    }),
  };
  const result = await currentSalesAgent('cand1', 'job1', { Model: mock });
  assert.equal(result, expected);
});

test('falls back to candidate-level row when no job-specific match', async () => {
  const fallback = { salesAgentUserId: 'agent2', jobId: null };
  let sortCalls = 0;
  const mock = {
    findOne: mockFindOne({
      direct: null,
      onSort: () => {
        sortCalls += 1;
        return sortCalls === 1 ? null : fallback;
      },
    }),
  };
  const result = await currentSalesAgent('cand1', 'job1', { Model: mock });
  assert.equal(result, fallback);
});
