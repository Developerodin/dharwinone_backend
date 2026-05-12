import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactKey } from '../aiArtifactStorage.service.js';

test('buildArtifactKey enforces meetings/<id>/<filename> shape', () => {
  assert.equal(buildArtifactKey('meeting_xyz', 'transcript.json'), 'meetings/meeting_xyz/transcript.json');
});

test('buildArtifactKey rejects path traversal', () => {
  assert.throws(() => buildArtifactKey('../danger', 'x.json'));
  assert.throws(() => buildArtifactKey('meeting', '../x.json'));
});
