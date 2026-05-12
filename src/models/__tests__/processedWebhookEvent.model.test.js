import { test } from 'node:test';
import assert from 'node:assert/strict';
import ProcessedWebhookEvent from '../processedWebhookEvent.model.js';

test('requires eventId, event, bodyHash', () => {
  const e = new ProcessedWebhookEvent({});
  const err = e.validateSync();
  assert.ok(err);
  assert.ok(err.errors.eventId);
  assert.ok(err.errors.event);
  assert.ok(err.errors.bodyHash);
});

test('accepts a valid payload', () => {
  const e = new ProcessedWebhookEvent({
    eventId: 'abc123',
    event: 'room_finished',
    roomName: 'meeting_xyz',
    bodyHash: 'sha256:...',
  });
  assert.equal(e.validateSync(), undefined);
});
