import { test } from 'node:test';
import assert from 'node:assert/strict';
import Recording from '../recording.model.js';

test('Recording has AI fields with default aiProcessingStatus=none', () => {
  const r = new Recording({ meetingId: 'meeting_x' });
  assert.equal(r.aiProcessingStatus, 'none');
  assert.equal(r.aiProcessingError, null);
  assert.equal(r.transcriptId, null);
  assert.equal(r.summaryId, null);
  assert.equal(r.transcriptUrl, null);
  assert.equal(r.summaryUrl, null);
  assert.equal(r.agentDispatchId, null);
});

test('Recording rejects unknown aiProcessingStatus', () => {
  const r = new Recording({ meetingId: 'meeting_x', aiProcessingStatus: 'gibberish' });
  const err = r.validateSync();
  assert.ok(err);
  assert.ok(err.errors.aiProcessingStatus);
});

test('Recording aiProcessingStatus accepts every documented value', () => {
  const allowed = ['none','pending','dispatching','transcribing','finalizing','completed','failed'];
  for (const v of allowed) {
    const r = new Recording({ meetingId: 'meeting_x', aiProcessingStatus: v });
    assert.equal(r.validateSync(), undefined, `should accept ${v}`);
  }
});
