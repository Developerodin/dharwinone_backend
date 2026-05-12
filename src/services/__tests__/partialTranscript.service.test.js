import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPartialKey, buildMetaKey } from '../partialTranscript.service.js';

test('buildPartialKey returns pt:<meetingId>', () => {
  assert.equal(buildPartialKey('meeting_abc'), 'pt:meeting_abc');
});

test('buildMetaKey returns pt:<meetingId>:meta', () => {
  assert.equal(buildMetaKey('meeting_abc'), 'pt:meeting_abc:meta');
});
