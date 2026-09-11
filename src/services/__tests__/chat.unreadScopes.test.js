import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUnreadScopes } from '../chat.service.js';

/**
 * Unread used to be one countDocuments per listed conversation. It is now a single aggregate,
 * which means the per-participant read cursor has to survive as one $or clause per conversation
 * — the part that is easy to get wrong when the viewer is not the first participant, or has
 * never opened the thread at all.
 */

const READ_AT = new Date('2026-09-01T10:00:00.000Z');
const ME = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb2';

const conv = (id, participants) => ({ _id: id, participants });
const participant = (userId, lastReadAt = null) => ({ user: { _id: userId }, lastReadAt });

test('a conversation the viewer has read is bounded by their own cursor', () => {
  const scopes = buildUnreadScopes([conv('c1', [participant(ME, READ_AT)])], ME);
  assert.deepEqual(scopes, [{ conversation: 'c1', createdAt: { $gt: READ_AT } }]);
});

test('a conversation the viewer has never opened counts everything', () => {
  const scopes = buildUnreadScopes([conv('c1', [participant(ME, null)])], ME);
  assert.deepEqual(scopes, [{ conversation: 'c1' }]);
});

test("another participant's cursor is never used as the viewer's", () => {
  // The viewer is second in the array and has no cursor; the first participant has one.
  const scopes = buildUnreadScopes(
    [conv('c1', [participant(OTHER, READ_AT), participant(ME, null)])],
    ME
  );
  assert.deepEqual(scopes, [{ conversation: 'c1' }], 'must not inherit the other cursor');
});

test('a viewer missing from the participant list counts everything rather than throwing', () => {
  const scopes = buildUnreadScopes([conv('c1', [participant(OTHER, READ_AT)])], ME);
  assert.deepEqual(scopes, [{ conversation: 'c1' }]);
});

test('every listed conversation gets exactly one clause, and an empty page gets none', () => {
  const scopes = buildUnreadScopes(
    [conv('c1', [participant(ME, READ_AT)]), conv('c2', [participant(ME, null)])],
    ME
  );
  assert.equal(scopes.length, 2);
  assert.deepEqual(buildUnreadScopes([], ME), []);
});
