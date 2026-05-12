import { test } from 'node:test';
import assert from 'node:assert/strict';
import SummaryDeadLetter from '../summaryDeadLetter.model.js';

test('requires meetingId, jobId, attempts, lastError, payload', () => {
  const e = new SummaryDeadLetter({});
  const err = e.validateSync();
  assert.ok(err);
  assert.ok(err.errors.meetingId);
  assert.ok(err.errors.jobId);
  assert.ok(err.errors.attempts);
  assert.ok(err.errors.lastError);
  assert.ok(err.errors.payload);
});

test('accepts a valid row', () => {
  const e = new SummaryDeadLetter({
    meetingId: 'meeting_x',
    jobId: 'bullmq-1',
    attempts: 3,
    lastError: 'OpenAI timeout',
    payload: { meetingId: 'meeting_x', recordingId: '67afaaaaaaaaaaaaaaaaaaaa' },
  });
  assert.equal(e.validateSync(), undefined);
});
