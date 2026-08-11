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
import { getUserIdsWithApiPermission } from './permission.service.js';
import { sendPushToUser } from './push.service.js';
import * as chatCallService from './chatCall.service.js';
import { deleteInterviewRoom } from './livekit.service.js';
import { buildChatMessagePreview } from '../utils/chatMessagePreview.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';

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
        try {
          const result = await chatService.markConversationDelivered(conversationId, userId);
          if (result.messageIds?.length) {
            const payload = {
              conversationId: result.conversationId,
              userId: result.userId,
              deliveredAt: result.deliveredAt,
              messageIds: result.messageIds,
            };
            io.to(`conversation:${conversationId}`).emit('conversation_delivered', payload);
            const participantIds = await chatService.getConversationParticipantIds(conversationId);
            for (const pid of participantIds || []) {
              const pidStr = String(pid);
              if (pidStr === String(userId)) continue;
              io.to(`user:${pidStr}`).emit('conversation_delivered', payload);
            }
          }
        } catch (deliverErr) {
          logger.warn(`join deliver failed: ${deliverErr.message}`);
        }
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
          const result = await chatService.markAsRead(conversationId, userId);
          const payload = {
            conversationId,
            userId,
            readAt: result.readAt || new Date().toISOString(),
          };
          // Conversation room (open threads) + each other participant's user room
          // so senders get realtime blue ticks even if they left the thread.
          socket.to(`conversation:${conversationId}`).emit('messages_read', payload);
          try {
            const participantIds = await chatService.getConversationParticipantIds(conversationId);
            for (const pid of participantIds || []) {
              const pidStr = String(pid);
              if (pidStr === String(userId)) continue;
              io.to(`user:${pidStr}`).emit('messages_read', payload);
            }
          } catch (notifyErr) {
            logger.warn(`messages_read user notify failed: ${notifyErr.message}`);
          }
        } catch (err) {
          logger.warn(`message_read failed for ${conversationId}: ${err.message}`);
        }
      }
    });

    socket.on('message_delivered', async (data) => {
      const { conversationId, messageId } = data || {};
      if (!conversationId || !messageId) return;
      try {
        const result = await chatService.markMessageDelivered(conversationId, messageId, userId);
        if (result?.already) return;
        const payload = {
          conversationId: result.conversationId,
          messageId: result.messageId,
          userId: result.userId,
          deliveredAt: result.deliveredAt,
        };
        io.to(`conversation:${conversationId}`).emit('message_delivered', payload);
        // Notify the original sender directly (critical for 1:1 realtime grey ticks).
        if (result.senderId) {
          io.to(`user:${result.senderId}`).emit('message_delivered', payload);
        }
      } catch (err) {
        logger.warn(`message_delivered failed: ${err.message}`);
      }
    });

    socket.on('conversation_delivered', async (data) => {
      const { conversationId } = data || {};
      if (!conversationId) return;
      try {
        const result = await chatService.markConversationDelivered(conversationId, userId);
        if (!result.messageIds?.length) return;
        const payload = {
          conversationId: result.conversationId,
          userId: result.userId,
          deliveredAt: result.deliveredAt,
          messageIds: result.messageIds,
        };
        io.to(`conversation:${conversationId}`).emit('conversation_delivered', payload);
        try {
          const participantIds = await chatService.getConversationParticipantIds(conversationId);
          for (const pid of participantIds || []) {
            const pidStr = String(pid);
            if (pidStr === String(userId)) continue;
            io.to(`user:${pidStr}`).emit('conversation_delivered', payload);
          }
        } catch (notifyErr) {
          logger.warn(`conversation_delivered user notify failed: ${notifyErr.message}`);
        }
      } catch (err) {
        logger.warn(`conversation_delivered failed: ${err.message}`);
      }
    });

    socket.on('call:initiate', async (data, cb) => {
      try {
        const { conversationId, callType } = data || {};
        if (!conversationId || !callType) return cb?.({ error: 'conversationId and callType required' });
        const call = await chatCallService.initiateCall(conversationId, userId, callType);
        const callId = String(call._id);
        const roomName = `chat-${conversationId}-${callId}`;
        const [participantIds, conv] = await Promise.all([
          chatService.getConversationParticipantIds(conversationId),
          chatService.ensureParticipant(conversationId, userId),
        ]);
        const conversationType = conv?.type === 'group' ? 'group' : 'direct';
        const callScope = conversationType;
        const groupName =
          conversationType === 'group'
            ? String(conv?.name || 'Group').trim() || 'Group'
            : undefined;
        const participantCount = participantIds.length;
        const callerName = socket.userName || 'Someone';

        participantIds.forEach((pid) => {
          const pidStr = String(pid);
          if (pidStr !== userId) {
            const incomingPayload = {
              callId,
              conversationId,
              callType,
              callScope,
              conversationType,
              roomName,
              participantIds,
              participantCount,
              caller: { id: userId, name: callerName },
              ...(groupName !== undefined && { groupName }),
            };
            io.to(`user:${pidStr}`).emit('call:incoming', incomingPayload);
            const pushTitle =
              conversationType === 'group'
                ? `Incoming group ${callType === 'video' ? 'video' : 'voice'} call`
                : `Incoming ${callType === 'video' ? 'video' : 'voice'} call`;
            const pushBody =
              conversationType === 'group' && groupName
                ? `${callerName} started a group call in ${groupName}`
                : `${callerName} is calling`;
            sendPushToUser(pidStr, {
              title: pushTitle,
              body: pushBody,
              data: {
                type: 'incoming_call',
                callId,
                conversationId,
                callType,
                callScope,
                conversationType,
                callerName,
                roomName,
                participantCount: String(participantCount),
                ...(groupName !== undefined && { groupName }),
              },
              channelId: 'incoming-calls',
            }).catch((e) => logger.warn('[push] call push failed: %s', e?.message || e));
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
      // Only persist a bell notification for participants who can actually open the
      // chats page (chats.read). Otherwise they get a notification whose link the
      // route guard blocks (e.g. employees added to a conversation without chat access).
      // ponytail: per-message role scan (2 queries); add a short TTL cache if chat volume makes this hot.
      const chatPermittedIds = new Set(await getUserIdsWithApiPermission('chats.read'));
      const preview = buildChatMessagePreview(payload);
      const firstAttachment = Array.isArray(payload.attachments) ? payload.attachments[0] : null;
      let imageUrl = preview.imageUrl;
      if (preview.kind === 'image' && firstAttachment?.key) {
        try {
          imageUrl = await generatePresignedDownloadUrl(firstAttachment.key, 3600);
        } catch (err) {
          logger.warn(`chat notify image URL failed: ${err.message}`);
        }
      }

      for (const uid of participantIds) {
        const uidStr = String(uid);
        // conversation_updated to all participants (sidebar badge/preview)
        io.to(`user:${uidStr}`).emit('conversation_updated', {
          conversationId,
          lastMessage: {
            content: preview.text,
            sender: payload.sender?.name || '',
            createdAt: payload.createdAt,
            type: payload.type,
          },
        });
        // new_message to non-sender user rooms — fires toast even when recipient not on chat page
        if (uidStr !== senderStr) {
          io.to(`user:${uidStr}`).emit('new_message', payload);
          // Persist to Notification collection unless recipient is actively viewing this conversation
          const sockets = io.sockets;
          const room = sockets.adapter.rooms.get(`conversation:${conversationId}`);
          const isActive = room && [...room].some(
            (sid) => sockets.sockets.get(sid)?.data?.userId === uidStr
          );
          if (!isActive && chatPermittedIds.has(uidStr)) {
            notify(uid, {
              type: 'chat_message',
              title: payload.sender?.name || 'New message',
              message: preview.text.slice(0, 120),
              link: `/communication/chats?conv=${conversationId}`,
              triggeredBy: payload.sender?._id || payload.sender?.id,
              relatedEntity: { type: 'conversation', id: conversationId },
              metadata: {
                messageType: preview.kind,
                ...(preview.attachmentName ? { attachmentName: preview.attachmentName } : {}),
                ...(preview.documentType ? { documentType: preview.documentType } : {}),
                ...(imageUrl ? { imageUrl } : {}),
              },
              ...(imageUrl ? { richContent: { image: imageUrl } } : {}),
            }).catch((err) => logger.warn(`chat notify failed: ${err.message}`));
          }
        }
      }
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
    const callerName = callData.caller?.name || 'Someone';
    const callType = callData.callType || 'audio';
    const callScope = callData.callScope || callData.conversationType || 'direct';
    const isGroupInvite = callScope === 'group';
    if (ids?.length) {
      ids.forEach((uid) => {
        const uidStr = String(uid);
        if (callerStr && uidStr === callerStr) return;
        io.to(`user:${uidStr}`).emit('incoming_call', callData);
        const pushTitle = isGroupInvite
          ? `Incoming group ${callType === 'video' ? 'video' : 'voice'} call`
          : `Incoming ${callType === 'video' ? 'video' : 'voice'} call`;
        const pushBody =
          isGroupInvite && callData.groupName
            ? `${callerName} started a group call in ${callData.groupName}`
            : isGroupInvite
              ? `${callerName} started a group call`
              : `${callerName} is calling`;
        sendPushToUser(uidStr, {
          title: pushTitle,
          body: pushBody,
          data: {
            type: 'incoming_call',
            callId: String(callData.callId || ''),
            conversationId: String(conversationId || ''),
            callType,
            callScope,
            callerName,
            ...(callData.conversationType ? { conversationType: callData.conversationType } : {}),
            ...(callData.groupName ? { groupName: callData.groupName } : {}),
            ...(callData.roomName ? { roomName: callData.roomName } : {}),
            ...(callData.participantCount != null ? { participantCount: String(callData.participantCount) } : {}),
          },
          channelId: 'incoming-calls',
        }).catch((e) => logger.warn('[push] incoming_call push failed: %s', e?.message || e));
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

const emitMessageDeleted = async (conversationId, messageId, deleteFor, deletedBy) => {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit('message_deleted', {
    conversationId,
    messageId,
    deleteFor,
    deletedBy: deletedBy != null ? String(deletedBy) : undefined,
  });

  if (deleteFor !== 'everyone') return;

  try {
    const participantIds = await chatService.getConversationParticipantIds(conversationId);
    for (const uid of participantIds) {
      const lastMessage = await chatService.getLastMessagePreview(conversationId, uid);
      io.to(`user:${uid}`).emit('conversation_updated', { conversationId, lastMessage });
    }
  } catch (err) {
    logger.warn(`message_deleted conversation_updated emit failed: ${err.message}`);
  }
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
  const direction =
    record.telephonyData?.direction ||
    record.direction ||
    undefined;
  const payload = {
    id,
    executionId: record.executionId,
    callSid: record.executionId,
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
    direction,
    createdAt: record.createdAt,
    telephonyData: record.telephonyData,
  };
  io.to('role:admin').emit('call:update', payload);
  if (record.candidate) io.to(`call:candidate:${record.candidate}`).emit('call:update', payload);
  if (record.job) io.to(`call:job:${record.job}`).emit('call:update', payload);

  // Dialer Softphone history — push to the owning user so Calls / Contacts
  // refresh without a manual pull-to-refresh.
  const ownerId = record.createdBy?.toString?.() || record.createdBy || null;
  if (ownerId) {
    io.to(`user:${ownerId}`).emit('call:update', payload);
    io.to(`user:${ownerId}`).emit('call-history-updated', payload);
  }
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
