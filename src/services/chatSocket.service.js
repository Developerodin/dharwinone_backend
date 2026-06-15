import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';
import { tokenTypes } from '../config/tokens.js';
import User from '../models/user.model.js';
import Role from '../models/role.model.js';
import ChatCall from '../models/chatCall.model.js';
import * as chatService from './chat.service.js';
import logger from '../config/logger.js';
import { notify } from './notification.service.js';
import * as chatCallService from './chatCall.service.js';
import { deleteInterviewRoom } from './livekit.service.js';

let io = null;

/** userId -> Set<socketId> */
const onlineUsers = new Map();

const initSocket = (httpServer) => {
  // Reuse the same allowed origins as the Express app (config.corsOrigin, from CORS_ORIGIN).
  // Previously this was hardcoded to `false` in production, which sent no
  // Access-Control-Allow-Origin header and blocked every browser handshake from the
  // deployed frontends (CORS error in the console / socket never connects).
  // `config.corsOrigin` is `true` when CORS_ORIGIN is unset (dev) or an array of origins.
  const corsOrigin = config.corsOrigin;
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    path: '/socket.io',
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const payload = jwt.verify(token, config.jwt.secret);
      if (payload.type !== tokenTypes.ACCESS) return next(new Error('Invalid token'));
      const user = await User.findById(payload.sub).lean();
      if (!user || user.status !== 'active') return next(new Error('User not found or inactive'));
      socket.userId = user._id.toString();
      socket.userName = user.name;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;

    socket.join(`user:${userId}`);

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    io.emit('user_online', { userId });

    // Admins receive every Bolna call:update on role:admin (see emitCallUpdate).
    (async () => {
      try {
        const fullUser = await User.findById(userId).select('roleIds platformSuperUser').lean();
        if (fullUser?.platformSuperUser) {
          socket.join('role:admin');
          return;
        }
        const roleIds = fullUser?.roleIds || [];
        if (!roleIds.length) return;
        const adminRole = await Role.findOne({
          _id: { $in: roleIds },
          name: 'Administrator',
          status: 'active',
        })
          .select('_id')
          .lean();
        if (adminRole) socket.join('role:admin');
      } catch (err) {
        logger.warn(`socket admin room join failed: ${err.message}`);
      }
    })();

    socket.on('subscribe:call', (data) => {
      const { scope, id } = data || {};
      const scopedId = id != null ? String(id).trim() : '';
      if (!scopedId) return;
      if (scope === 'candidate') socket.join(`call:candidate:${scopedId}`);
      else if (scope === 'job') socket.join(`call:job:${scopedId}`);
    });

    socket.on('unsubscribe:call', (data) => {
      const { scope, id } = data || {};
      const scopedId = id != null ? String(id).trim() : '';
      if (!scopedId) return;
      if (scope === 'candidate') socket.leave(`call:candidate:${scopedId}`);
      else if (scope === 'job') socket.leave(`call:job:${scopedId}`);
    });

    socket.on('join_conversation', async (data, cb) => {
      try {
        const { conversationId } = data || {};
        if (!conversationId) return cb?.({ error: 'conversationId required' });
        await chatService.ensureParticipant(conversationId, userId);
        socket.join(`conversation:${conversationId}`);
        cb?.({ success: true });
      } catch (err) {
        cb?.({ error: err.message || 'Failed to join' });
      }
    });

    socket.on('leave_conversation', (data) => {
      const { conversationId } = data || {};
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    socket.on('send_message', async (data, cb) => {
      try {
        const { conversationId, content, type, attachments, replyTo } = data || {};
        if (!conversationId || (content == null && (!attachments || !attachments.length))) {
          return cb?.({ error: 'conversationId and content (or attachments) required' });
        }
        const msg = await chatService.createMessage(conversationId, userId, { content, type, attachments, replyTo });
        await emitNewMessage(conversationId, msg);
        cb?.({ success: true, message: msg });
      } catch (err) {
        cb?.({ error: err.message || 'Failed to send' });
      }
    });

    socket.on('typing', (data) => {
      const { conversationId } = data || {};
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit('user_typing', {
          conversationId,
          userId,
          userName: socket.userName,
        });
      }
    });

    socket.on('message_read', async (data) => {
      const { conversationId } = data || {};
      if (conversationId) {
        try {
          await chatService.markAsRead(conversationId, userId);
          socket.to(`conversation:${conversationId}`).emit('messages_read', {
            conversationId,
            userId,
            readAt: new Date().toISOString(),
          });
        } catch (err) {
          logger.warn(`message_read failed for ${conversationId}: ${err.message}`);
        }
      }
    });

    socket.on('call:initiate', async (data, cb) => {
      try {
        const { conversationId, callType } = data || {};
        if (!conversationId || !callType) return cb?.({ error: 'conversationId and callType required' });
        const call = await chatCallService.initiateCall(conversationId, userId, callType);
        const callId = String(call._id);
        const participantIds = await chatService.getConversationParticipantIds(conversationId);
        participantIds.forEach((pid) => {
          const pidStr = String(pid);
          if (pidStr !== userId) {
            io.to(`user:${pidStr}`).emit('call:incoming', {
              callId,
              conversationId,
              callType,
              caller: { id: userId, name: socket.userName },
            });
          }
        });
        cb?.({ success: true, callId });
      } catch (err) {
        cb?.({ error: err.message || 'Failed to initiate call' });
      }
    });

    socket.on('call:accept', async (data, cb) => {
      try {
        const { callId } = data || {};
        if (!callId) return cb?.({ error: 'callId required' });
        const result = await chatCallService.acceptCall(callId);
        if (!result) return cb?.({ error: 'Call no longer available' });
        const { call, tokens } = result;
        call.participants.forEach((p) => {
          const pidStr = String(p._id);
          const token = tokens[pidStr];
          if (token) {
            io.to(`user:${pidStr}`).emit('call:start', {
              callId: String(call._id),
              conversationId: String(call.conversation),
              roomName: call.livekitRoom,
              callType: call.callType,
              token,
            });
          }
        });
        cb?.({ success: true });
      } catch (err) {
        cb?.({ error: err.message || 'Failed to accept call' });
      }
    });

    socket.on('call:decline', async (data) => {
      const { callId } = data || {};
      if (!callId) return;
      try {
        const call = await chatCallService.declineCall(callId);
        if (call) {
          const callerId = String(call.caller);
          io.to(`user:${callerId}`).emit('call:declined', {
            callId,
            conversationId: String(call.conversation),
            declinedBy: userId,
          });
        }
      } catch (err) {
        logger.warn(`call:decline failed: ${err.message}`);
      }
    });

    socket.on('call:cancel', async (data) => {
      const { callId } = data || {};
      if (!callId) return;
      try {
        const call = await chatCallService.cancelCall(callId, userId);
        if (call) {
          const participantIds = await chatService.getConversationParticipantIds(String(call.conversation));
          participantIds.forEach((pid) => {
            io.to(`user:${String(pid)}`).emit('call:cancelled', {
              callId,
              conversationId: String(call.conversation),
              cancelledBy: userId,
            });
          });
        }
      } catch (err) {
        logger.warn(`call:cancel failed: ${err.message}`);
      }
    });

    socket.on('call:end', async (data) => {
      const { callId } = data || {};
      if (!callId) return;
      try {
        const call = await chatCallService.endCall(callId);
        if (call) {
          if (call.livekitRoom) {
            await deleteInterviewRoom(call.livekitRoom).catch((err) =>
              logger.warn(`call:end LiveKit cleanup failed: ${err?.message}`)
            );
          }
          const participantIds = await chatService.getConversationParticipantIds(String(call.conversation));
          participantIds.forEach((pid) => {
            io.to(`user:${String(pid)}`).emit('call_ended', {
              callId,
              conversationId: String(call.conversation),
              roomName: call.livekitRoom,
            });
          });
        }
      } catch (err) {
        logger.warn(`call:end failed: ${err.message}`);
      }
    });

    socket.on('get_online_users', (data, cb) => {
      const { userIds } = data || {};
      if (!Array.isArray(userIds)) return cb?.({ error: 'userIds array required' });
      const result = {};
      userIds.forEach((id) => {
        result[id] = onlineUsers.has(id) && onlineUsers.get(id).size > 0;
      });
      cb?.({ onlineUsers: result });
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          io.emit('user_offline', { userId });

          // End any ongoing calls this user was in — covers browser close / network drop.
          ChatCall.find({ participants: userId, status: 'ongoing' }).lean().then(async (ongoingCalls) => {
            for (const call of ongoingCalls) {
              await chatCallService.endCall(String(call._id)).catch(() => {});
              if (call.livekitRoom) {
                await deleteInterviewRoom(call.livekitRoom).catch(() => {});
                emitCallEnded(String(call.conversation), call.livekitRoom);
              }
            }
          }).catch((err) => logger.warn(`disconnect call cleanup failed: ${err?.message}`));

          // Cancel any ringing calls this user initiated — without this, the
          // call sits in "ringing" forever when the caller closes their tab
          // before the callee answers/declines.
          const ioRef = io;
          ChatCall.find({ caller: userId, status: 'ringing' }).lean().then(async (ringingCalls) => {
            await Promise.all(ringingCalls.map(async (call) => {
              const cancelled = await chatCallService.cancelCall(String(call._id), userId).catch(() => null);
              if (!cancelled) return;
              const participantIds = await chatService.getConversationParticipantIds(String(call.conversation)).catch(() => []);
              participantIds.forEach((pid) => {
                ioRef.to(`user:${String(pid)}`).emit('call:cancelled', {
                  callId: String(call._id),
                  conversationId: String(call.conversation),
                  cancelledBy: userId,
                });
              });
            }));
          }).catch((err) => logger.warn(`disconnect ring cleanup failed: ${err?.message}`));
        }
      }
    });
  });

  return io;
};

const emitNewMessage = async (conversationId, message) => {
  if (!io || !message) return;
  const obj = typeof message.toObject === 'function' ? message.toObject() : (typeof message.toJSON === 'function' ? message.toJSON() : message);
  const payload = { ...obj };
  if (payload._id && !payload.id) payload.id = payload._id.toString();
  if (!payload.createdAt && message.createdAt) payload.createdAt = message.createdAt;

  // Emit to conversation room (users actively viewing the conversation)
  io.to(`conversation:${conversationId}`).emit('new_message', payload);

  try {
    const participantIds = await chatService.getConversationParticipantIds(conversationId);
    if (participantIds && participantIds.length) {
      const senderStr = String(payload.sender?._id || payload.sender?.id || '');
      participantIds.forEach((uid) => {
        const uidStr = String(uid);
        // conversation_updated to all participants (sidebar badge/preview)
        io.to(`user:${uidStr}`).emit('conversation_updated', {
          conversationId,
          lastMessage: { content: payload.content, sender: payload.sender?.name || '', createdAt: payload.createdAt },
        });
        // new_message to non-sender user rooms — fires toast even when recipient not on chat page
        if (uidStr !== senderStr) {
          io.to(`user:${uidStr}`).emit('new_message', payload);
          // Persist to Notification collection unless recipient is actively viewing this conversation
          const room = io.sockets.adapter.rooms.get(`conversation:${conversationId}`);
          const isActive = room && [...room].some(
            (sid) => io.sockets.sockets.get(sid)?.data?.userId === uidStr
          );
          if (!isActive) {
            notify(uid, {
              type: 'chat_message',
              title: payload.sender?.name || 'New message',
              message: String(payload.content || '').slice(0, 120),
              link: `/communication/chats/${conversationId}`,
              triggeredBy: payload.sender?._id || payload.sender?.id,
              relatedEntity: { type: 'conversation', id: conversationId },
            }).catch((err) => logger.warn(`chat notify failed: ${err.message}`));
          }
        }
      });
    }
  } catch (err) {
    logger.warn(`conversation_updated emit failed: ${err.message}`);
  }
};

const emitCallEnded = (conversationId, roomName) => {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit('call_ended', { conversationId, roomName });
  try {
    chatService.getConversationParticipantIds(conversationId).then((ids) => {
      if (ids) ids.forEach((uid) => io.to(`user:${uid}`).emit('call_ended', { conversationId, roomName }));
    }).catch(() => {});
  } catch (err) {
    logger.warn(`call_ended emit failed: ${err.message}`);
  }
};

const emitIncomingCall = async (conversationId, callData) => {
  if (!io || !callData) return;
  io.to(`conversation:${conversationId}`).emit('incoming_call', callData);
  try {
    const ids = await chatService.getConversationParticipantIds(conversationId);
    const callerStr = callData.caller?.id != null ? String(callData.caller.id) : '';
    if (ids?.length) {
      ids.forEach((uid) => {
        if (callerStr && String(uid) === callerStr) return;
        io.to(`user:${uid}`).emit('incoming_call', callData);
      });
    }
  } catch (err) {
    logger.warn(`incoming_call emit to user rooms failed: ${err.message}`);
  }
};

/**
 * Targeted incoming “call” UI for support camera invites (same client handlers as chat calls).
 * @param {string} targetUserId
 * @param {{ token: string, roomName: string, caller: { id: string, name?: string, email?: string } }} payload
 */
const emitSupportCameraIncomingCall = (targetUserId, payload) => {
  if (!io || !targetUserId || !payload?.token || !payload?.roomName || !payload?.caller) return;
  const token = String(payload.token);
  const callData = {
    callSource: 'support_camera',
    supportInviteToken: token,
    roomName: payload.roomName,
    callType: 'video',
    conversationId: '',
    callId: `sc-${token.slice(0, 24)}`,
    caller: {
      id: String(payload.caller.id),
      name: payload.caller.name || 'Platform support',
      ...(payload.caller.email ? { email: payload.caller.email } : {}),
    },
  };
  io.to(`user:${String(targetUserId)}`).emit('incoming_call', callData);
};

const isUserOnline = (userId) => onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;

const getIO = () => io;

const emitMessageDeleted = (conversationId, messageId, deleteFor) => {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit('message_deleted', { conversationId, messageId, deleteFor });
};

const emitMessageReacted = (conversationId, message) => {
  if (!io || !message) return;
  io.to(`conversation:${conversationId}`).emit('message_reacted', { conversationId, message });
};

const emitConversationUpdated = async (conversationId) => {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit('conversation_updated', { conversationId });
  try {
    const participantIds = await chatService.getConversationParticipantIds(conversationId);
    if (participantIds?.length) {
      participantIds.forEach((uid) => {
        io.to(`user:${uid}`).emit('conversation_updated', { conversationId });
      });
    }
  } catch (err) {
    logger.warn(`conversation_updated emit failed: ${err.message}`);
  }
};

const emitConversationDeleted = (conversationId, participantIds) => {
  if (!io || !participantIds?.length) return;
  participantIds.forEach((uid) => {
    io.to(`user:${uid}`).emit('conversation_deleted', { conversationId });
  });
};

/**
 * Push a Bolna telephony CallRecord update to subscribed rooms.
 * Targets:
 *   - role:admin             — admin call dashboard sees every update
 *   - call:candidate:<id>    — candidate-scoped subscribers (e.g. ATS profile)
 *   - call:job:<id>          — job-scoped subscribers (e.g. job detail page)
 * Called by callSync.service.js::applyEvent and ::seedRecord.
 */
const emitCallUpdate = (record) => {
  if (!io || !record) return;
  const id = record._id?.toString?.() || record.id || null;
  const payload = {
    id,
    executionId: record.executionId,
    status: record.status,
    statusRank: record.statusRank,
    statusUpdatedAt: record.statusUpdatedAt,
    completedAt: record.completedAt,
    duration: record.duration,
    recordingUrl: record.recordingUrl,
    fromPhoneNumber: record.fromPhoneNumber,
    toPhoneNumber: record.toPhoneNumber,
    recipientPhoneNumber: record.recipientPhoneNumber,
    phone: record.phone,
    businessName: record.businessName,
    purpose: record.purpose,
    agentId: record.agentId,
    errorMessage: record.errorMessage,
  };
  io.to('role:admin').emit('call:update', payload);
  if (record.candidate) io.to(`call:candidate:${record.candidate}`).emit('call:update', payload);
  if (record.job) io.to(`call:job:${record.job}`).emit('call:update', payload);
};

export {
  initSocket,
  emitNewMessage,
  emitIncomingCall,
  emitSupportCameraIncomingCall,
  emitCallEnded,
  emitMessageDeleted,
  emitMessageReacted,
  emitConversationUpdated,
  emitConversationDeleted,
  emitCallUpdate,
  isUserOnline,
  getIO,
};
