import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeadLetterRow } from '../deadLetter.service.js';

test('buildDeadLetterRow extracts the right fields from a bullmq job', () => {
  const job = {
    id: 'finalize:meeting_x',
    data: { meetingId: 'meeting_x', recordingId: 'r1' },
    attemptsMade: 3,
  };
  const err = Object.assign(new Error('OpenAI timed out'), { stack: 'STACK_LINES' });
  const row = buildDeadLetterRow(job, err);
  assert.equal(row.meetingId, 'meeting_x');
  assert.equal(row.jobId, 'finalize:meeting_x');
  assert.equal(row.attempts, 3);
  assert.equal(row.lastError, 'OpenAI timed out');
  assert.equal(row.lastStack, 'STACK_LINES');
  assert.deepEqual(row.payload, job.data);
});
