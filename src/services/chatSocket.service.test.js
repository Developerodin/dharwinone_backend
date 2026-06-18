import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the notify() branch in emitNewMessage() so we can unit-test
// the isActive check without a real Socket.io server.
const makeEmitNewMessage = (io, notifyFn) => async (conversationId, message, participants) => {
  const payload = typeof message.toObject === 'function' ? message.toObject() : { ...message };
  if (payload._id && !payload.id) payload.id = payload._id.toString();
  const senderStr = String(payload.sender?._id || payload.sender?.id || '');

  participants.forEach((uid) => {
    const uidStr = String(uid);
    io.to(`user:${uidStr}`).emit('new_message', payload);

    if (uidStr !== senderStr) {
      const room = io.sockets.adapter.rooms.get(`conversation:${conversationId}`);
      const isActive = room && [...room].some(
        (sid) => io.sockets.sockets.get(sid)?.data?.userId === uidStr
      );
      if (!isActive) {
        notifyFn(uid, {
          type: 'chat_message',
          title: payload.sender?.name || 'New message',
          message: String(payload.content || '').slice(0, 120),
          link: `/communication/chats?conv=${conversationId}`,
          triggeredBy: payload.sender?._id || payload.sender?.id,
          relatedEntity: { type: 'conversation', id: conversationId },
        }).catch(() => {});
      }
    }
  });
};

const makeIo = (activeSocketUserId = null) => ({
  to: () => ({ emit: () => {} }),
  sockets: {
    adapter: {
      rooms: activeSocketUserId
        ? new Map([['conversation:conv1', new Set(['socket-abc'])]])
        : new Map(),
    },
    sockets: activeSocketUserId
      ? new Map([['socket-abc', { data: { userId: activeSocketUserId } }]])
      : new Map(),
  },
});

describe('emitNewMessage — notify() branch', () => {
  const conversationId = 'conv1';
  const sender = { _id: 'user-sender', name: 'Alice' };
  const recipient = 'user-recipient';
  const message = { sender, content: 'Hello', createdAt: new Date() };

  it('calls notify() for non-sender not in conversation room', async () => {
    const notifyFn = mock.fn(async () => {});
    const emitNewMessage = makeEmitNewMessage(makeIo(null), notifyFn);
    await emitNewMessage(conversationId, message, [sender._id, recipient]);

    assert.equal(notifyFn.mock.calls.length, 1);
    assert.equal(notifyFn.mock.calls[0].arguments[1].type, 'chat_message');
    assert.equal(notifyFn.mock.calls[0].arguments[1].relatedEntity.type, 'conversation');
  });

  it('skips notify() when recipient is actively viewing the conversation', async () => {
    const notifyFn = mock.fn(async () => {});
    const emitNewMessage = makeEmitNewMessage(makeIo(recipient), notifyFn);
    await emitNewMessage(conversationId, message, [sender._id, recipient]);

    assert.equal(notifyFn.mock.calls.length, 0);
  });

  it('does not propagate notify() rejection — socket emit still succeeds', async () => {
    const notifyFn = mock.fn(async () => { throw new Error('DB down'); });
    const emitNewMessage = makeEmitNewMessage(makeIo(null), notifyFn);

    await assert.doesNotReject(() =>
      emitNewMessage(conversationId, message, [sender._id, recipient])
    );
  });
});
