import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';
import { tokenTypes } from '../config/tokens.js';
import User from '../models/user.model.js';
import * as chatService from './chat.service.js';
import logger from '../config/logger.js';

let io = null;

/** userId -> Set<socketId> */
const onlineUsers = new Map();

const initSocket = (httpServer) => {
  const corsOrigin = config.env === 'production' ? false : ['http://localhost:3001', 'http://127.0.0.1:3001'];
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

  io.to(`conversation:${conversationId}`).emit('new_message', payload);

  try {
    const participantIds = await chatService.getConversationParticipantIds(conversationId);
    if (participantIds && participantIds.length) {
      participantIds.forEach((uid) => {
        io.to(`user:${uid}`).emit('conversation_updated', {
          conversationId,
          lastMessage: { content: payload.content, sender: payload.sender?.name || '', createdAt: payload.createdAt },
        });
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
    if (ids) ids.forEach((uid) => io.to(`user:${uid}`).emit('incoming_call', callData));
  } catch (err) {
    logger.warn(`incoming_call emit to user rooms failed: ${err.message}`);
  }
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

export { initSocket, emitNewMessage, emitIncomingCall, emitCallEnded, emitMessageDeleted, emitMessageReacted, emitConversationUpdated, emitConversationDeleted, isUserOnline, getIO };
