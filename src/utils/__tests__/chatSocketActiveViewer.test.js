import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUserActiveInConversationRoom,
  socketBelongsToUser,
} from '../chatSocketActiveViewer.js';

describe('socketBelongsToUser', () => {
  it('matches socket.userId set by auth middleware', () => {
    assert.equal(socketBelongsToUser({ userId: 'user-1' }, 'user-1'), true);
    assert.equal(socketBelongsToUser({ userId: 'user-1' }, 'user-2'), false);
  });

  it('falls back to socket.data.userId for legacy adapters', () => {
    assert.equal(socketBelongsToUser({ data: { userId: 'user-1' } }, 'user-1'), true);
  });
});

describe('isUserActiveInConversationRoom', () => {
  const makeIo = (socketShape) => ({
    sockets: {
      adapter: {
        rooms: new Map([['conversation:conv1', new Set(['socket-abc'])]]),
      },
      sockets: new Map([['socket-abc', socketShape]]),
    },
  });

  it('detects active viewer via socket.userId (auth path)', () => {
    assert.equal(
      isUserActiveInConversationRoom(makeIo({ userId: 'user-recipient' }), 'conv1', 'user-recipient'),
      true
    );
  });

  it('does not treat data.userId-only check as required — root userId is enough', () => {
    // Regression: old code checked only socket.data.userId and missed auth's socket.userId
    assert.equal(
      isUserActiveInConversationRoom(makeIo({ userId: 'user-recipient', data: {} }), 'conv1', 'user-recipient'),
      true
    );
  });

  it('returns false when viewer is not in the room', () => {
    assert.equal(
      isUserActiveInConversationRoom(makeIo({ userId: 'other' }), 'conv1', 'user-recipient'),
      false
    );
    assert.equal(isUserActiveInConversationRoom(makeIo({ userId: 'x' }), 'missing', 'x'), false);
  });
});
