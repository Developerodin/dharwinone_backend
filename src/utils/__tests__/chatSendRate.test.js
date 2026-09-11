import test from 'node:test';
import assert from 'node:assert/strict';

import { assertChatSendAllowed, resetChatSendRate, MAX_PER_WINDOW, WINDOW_MS } from '../chatSendRate.js';

/**
 * The hole this closes: message creation had no cap on any path, and the Socket.IO
 * `send_message` handler is the cheapest one to abuse. The cap lives in the service, so a
 * single counter covers REST send, REST upload, forward and socket.
 */

test('allows up to the cap inside one window, then rejects', () => {
  resetChatSendRate();
  const now = 1000000;
  for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
    assertChatSendAllowed('user-a', now);
  }
  assert.throws(() => assertChatSendAllowed('user-a', now), (err) => err.statusCode === 429);
});

test('the window resets, and one sender does not consume another sender budget', () => {
  resetChatSendRate();
  const now = 2000000;
  for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
    assertChatSendAllowed('user-a', now);
  }
  // Different user, same instant — unaffected.
  assertChatSendAllowed('user-b', now);
  // Same user, next window — allowed again.
  assertChatSendAllowed('user-a', now + WINDOW_MS);
});
