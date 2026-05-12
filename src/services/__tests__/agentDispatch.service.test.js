import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchMetadata } from '../agentDispatch.service.js';

test('buildDispatchMetadata returns JSON with the three required fields', () => {
  const out = buildDispatchMetadata({ meetingId: 'm', recordingId: 'r', hmacToken: 'h' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.meetingId, 'm');
  assert.equal(parsed.recordingId, 'r');
  assert.equal(parsed.hmacToken, 'h');
});

test('buildDispatchMetadata stringifies ObjectId-like values', () => {
  const out = buildDispatchMetadata({
    meetingId: 'm',
    recordingId: { toString: () => '67aaaaaaaaaaaaaaaaaaaaaa' },
    hmacToken: 'h',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.recordingId, '67aaaaaaaaaaaaaaaaaaaaaa');
});
