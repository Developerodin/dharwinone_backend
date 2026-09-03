import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as chatService from '../services/chat.service.js';
import {
  emitNewMessage,
  emitIncomingCall,
  emitCallEnded,
  emitCallCancelled,
  emitCallDeclined,
  emitMessageDeleted,
  emitMessageReacted,
  emitConversationUpdated,
  emitConversationDeleted,
  emitConversationDelivered,
  getIO,
} from '../services/chatSocket.service.js';
import mongoose from 'mongoose';
import User from '../models/user.model.js';
import {
  baseEligible,
  directoryScope,
  serializeContact,
  CONTACT_REASONS,
  lookupExactEmail,
} from '../services/communicationAccess.service.js';
import {
  hashEmail,
  recordLookup,
  dailyLookupCount,
  LOOKUP_DAILY_CAP,
} from '../services/communicationAccess.audit.js';
import { uploadFileToS3 } from '../services/upload.service.js';
import logger from '../config/logger.js';

const getUserId = (req) => req.user?.id || req.user?._id?.toString();

const ACCESS_TOKEN_COOKIE = 'accessToken';

const getSocketToken = catchAsync(async (req, res) => {
  const token = req.cookies?.[ACCESS_TOKEN_COOKIE] || req.headers?.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ token });
});

const listConversations = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const { type } = req.query;
  const result = await chatService.listConversations(userId, { page, limit, type });
  res.send(result);
});

const listConversationPreferences = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const result = await chatService.listConversationPreferences(userId);
  res.send(result);
});

const createConversation = catchAsync(async (req, res) => {
  const conv = await chatService.createConversation(getUserId(req), req.body, req.user);
  res.status(httpStatus.CREATED).send(conv);
});

const getConversation = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.getConversation(req.params.id, userId);
  res.send(conv);
});

const deleteConversation = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { participantIds } = await chatService.deleteConversation(req.params.id, userId);
  emitConversationDeleted(req.params.id, participantIds);
  res.status(httpStatus.NO_CONTENT).end();
});

const getMessages = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const before = req.query.before;
  const limit = parseInt(req.query.limit, 10) || 50;
  const messages = await chatService.getMessages(req.params.id, userId, { before, limit });
  res.send(messages);
});

const getConversationMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const msg = await chatService.getConversationMessage(req.params.id, req.params.msgId, userId);
  res.send(msg);
});

const getConversationTimeline = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const limit = parseInt(req.query.limit, 10) || 20;
  const { before, beforeId, beforeKind } = req.query;
  const timeline = await chatService.getConversationTimeline(req.params.id, userId, {
    before,
    beforeId,
    beforeKind,
    limit,
  });
  res.send(timeline);
});

const sendMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const msg = await chatService.createMessage(req.params.id, userId, req.body);
  await emitNewMessage(req.params.id, msg);
  res.status(httpStatus.CREATED).send(msg);
});

const collectUploadedChatFiles = (req) => {
  if (Array.isArray(req.files)) {
    return req.files;
  }
  if (req.files && typeof req.files === 'object') {
    return [...(req.files.files || []), ...(req.files.file || [])];
  }
  return req.file ? [req.file] : [];
};

const uploadAndSendMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const files = collectUploadedChatFiles(req);
  if (!files.length) {
    return res.status(httpStatus.BAD_REQUEST).json({ error: 'No files provided' });
  }

  const attachments = [];
  for (const file of files) {
    const result = await uploadFileToS3(file, userId, 'chat-attachments');
    attachments.push(result);
  }

  const isImage = files.every((f) => f.mimetype?.startsWith('image/'));
  const isAudio = files.every((f) => f.mimetype?.startsWith('audio/'));
  const isVideo = files.every((f) => f.mimetype?.startsWith('video/'));
  const msgType = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file';
  const content = req.body?.content || req.body?.text || '';
  const replyTo = req.body?.replyTo || undefined;

  const msg = await chatService.createMessage(req.params.id, userId, {
    content,
    type: msgType,
    attachments,
    replyTo,
  });
  await emitNewMessage(req.params.id, msg);
  res.status(httpStatus.CREATED).send(msg);
});

const deleteMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const deleteFor = req.body?.deleteFor || 'me';
  const msg = await chatService.deleteMessage(req.params.id, req.params.msgId, userId, { deleteFor });
  await emitMessageDeleted(req.params.id, req.params.msgId, deleteFor, userId);
  res.send(msg);
});

const forwardMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { targetConversationId, targetConversationIds } = req.body;
  const results = await chatService.forwardMessage(req.params.id, req.params.msgId, userId, {
    targetConversationId,
    targetConversationIds,
  });
  for (const item of results) {
    // eslint-disable-next-line no-await-in-loop
    await emitNewMessage(item.conversationId, item.message);
  }
  res.status(httpStatus.CREATED).send({
    count: results.length,
    messages: results.map((r) => r.message),
  });
});

const reactToMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { emoji } = req.body || {};
  const msg = await chatService.reactToMessage(req.params.id, req.params.msgId, userId, {
    emoji: emoji || '👍',
  });
  emitMessageReacted(req.params.id, msg);
  res.send(msg);
});

const markAsDelivered = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conversationId = req.params.id;
  const result = await chatService.markConversationDelivered(conversationId, userId);
  try {
    await emitConversationDelivered(conversationId, result);
  } catch (err) {
    logger.warn(`markAsDelivered notify failed: ${err.message}`);
  }
  res.send({
    success: true,
    deliveredAt: result.deliveredAt,
    messageIds: result.messageIds ?? [],
  });
});

const markAsRead = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conversationId = req.params.id;

  // Record delivery before read so REST clients (and cold starts) never skip grey ticks.
  try {
    const deliverResult = await chatService.markConversationDelivered(conversationId, userId);
    await emitConversationDelivered(conversationId, deliverResult);
  } catch (err) {
    logger.warn(`markAsRead deliver failed: ${err.message}`);
  }

  const result = await chatService.markAsRead(conversationId, userId);

  // Broadcast even when the client only hit REST (socket may be down).
  // Socket `message_read` may also emit — clients treat receipts as idempotent.
  try {
    const io = getIO();
    if (io) {
      const payload = {
        conversationId,
        userId: String(userId),
        readAt: result.readAt || new Date().toISOString(),
      };
      io.to(`conversation:${conversationId}`).emit('messages_read', payload);
      const participantIds = await chatService.getConversationParticipantIds(conversationId);
      for (const pid of participantIds || []) {
        const pidStr = String(pid);
        if (pidStr === String(userId)) continue;
        io.to(`user:${pidStr}`).emit('messages_read', payload);
      }
    }
  } catch (err) {
    logger.warn(`markAsRead notify failed: ${err.message}`);
  }

  res.send({ success: true, readAt: result.readAt });
});

const listCalls = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const result = await chatService.listCallsForUser(userId, { page, limit });
  res.send(result);
});

const listCallsForConversation = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const limit = parseInt(req.query.limit, 10) || 50;
  const before = req.query.before;
  const calls = await chatService.listCallsForConversation(req.params.id, userId, { before, limit });
  res.send(calls);
});

const getActiveCallForConversation = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const result = await chatService.getActiveCallForConversation(req.params.id, userId);
  res.send(result);
});

const initiateCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { callType } = req.body;
  const result = await chatService.createCall(req.params.id, userId, { callType });

  const conv = result.call?.conversation;
  const isPopulated =
    conv && typeof conv === 'object' && (conv.type === 'group' || conv.type === 'direct');
  const conversationType = isPopulated ? conv.type : 'direct';
  const groupName =
    conversationType === 'group'
      ? String(conv.name || 'Group').trim() || 'Group'
      : undefined;

  const participantIds = (result.call?.participants || []).map((p) =>
    String(p?.id || p?._id || p)
  );
  emitIncomingCall(req.params.id, {
    conversationId: req.params.id,
    callId: result.call?.id || result.call?._id?.toString(),
    roomName: result.roomName,
    callType: callType || 'audio',
    callScope: conversationType,
    caller: { id: userId, name: req.user?.name, email: req.user?.email },
    conversationType,
    participantIds,
    participantCount: participantIds.length,
    ...(groupName !== undefined && { groupName }),
  });

  res.status(httpStatus.CREATED).send(result);
});

const initiateGroupCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { participantIds, callType } = req.body;
  const result = await chatService.createGroupCall(userId, { participantIds, callType }, req.user);

  const conversationType = result.conversationId ? 'group' : 'direct';
  const groupName = result.groupName || undefined;

  // Emit incoming call to all participants except the caller.
  const io = getIO();
  const otherIds = (participantIds || []).map(String).filter((id) => id !== userId);
  for (const pid of otherIds) {
    io.to(`user:${pid}`).emit('incoming_call', {
      conversationId: result.conversationId || result.call?._id?.toString() || '',
      callId: result.call?._id?.toString() || result.call?.id || '',
      roomName: result.roomName,
      callType: callType || 'audio',
      caller: { id: userId, name: req.user?.name, email: req.user?.email },
      conversationType,
      ...(groupName ? { groupName } : {}),
    });
  }

  res.status(httpStatus.CREATED).send(result);
});

const startChatCallRecording = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const result = await chatService.startChatCallRecording(req.params.id, userId);
  res.status(httpStatus.OK).send(result);
});

const getCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const call = await chatService.getCallById(req.params.id, userId);
  res.send(call);
});

const updateCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const callId = req.params.id;
  const before = await chatService.getCallById(callId, userId);
  const previousStatus = String(before?.status ?? '').toLowerCase();
  const callerId = String(before?.caller?.id ?? before?.caller?._id ?? before?.caller ?? '');

  const call = await chatService.updateCall(callId, userId, req.body);
  const newStatus = String(req.body?.status ?? call?.status ?? '').toLowerCase();
  const preConnect = previousStatus === 'initiated' || previousStatus === 'ringing';

  if (preConnect && previousStatus !== newStatus) {
    if (newStatus === 'missed' && callerId === userId) {
      await emitCallCancelled(call, userId);
    } else if (newStatus === 'declined' && callerId !== userId) {
      await emitCallDeclined(call, userId);
    }
  }

  res.send(call);
});

const endCallByRoom = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { roomName } = req.body;
  if (!roomName) return res.status(400).json({ message: 'roomName required' });
  const result = await chatService.endCallByRoom(roomName, userId);
  if (result) {
    await emitCallEnded(result.conversationId, roomName, {
      callId: result.callId,
      call: result.call,
    });
  }
  res.send({ success: true });
});

const searchUsers = catchAsync(async (req, res) => {
  const viewer = req.user;
  const viewerId = getUserId(req);
  const scope = await directoryScope(viewer);

  if (scope.kind === 'none') {
    return res.status(httpStatus.FORBIDDEN).json({
      code: httpStatus.FORBIDDEN,
      message: 'Contact directory is not available for your role',
    });
  }

  const search = req.query.search?.trim();
  const limit = Math.min(250, parseInt(req.query.limit, 10) || 20);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const filter = await baseEligible(viewerId);

  if (scope.kind === 'referred') {
    filter._id = {
      ...filter._id,
      $in: [...scope.ids].map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  if (search) {
    const collapsed = search.replace(/\s+/g, ' ');
    const escaped = collapsed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped.replace(/ /g, '\\s+'), 'i');
    filter.$or = [{ name: { $regex: rx } }, { email: { $regex: rx } }];
  }

  const result = await User.paginate(filter, {
    limit,
    page,
    sortBy: 'name:asc,_id:asc',
  });

  const reason =
    scope.kind === 'referred' ? CONTACT_REASONS.DIRECTORY_REFERRED : CONTACT_REASONS.DIRECTORY_ALL;

  const rows = result.results || [];
  const roleIds = [...new Set(rows.flatMap((u) => (u.roleIds || []).map(String)))];
  const roleNameById = new Map();
  if (roleIds.length) {
    const Role = (await import('../models/role.model.js')).default;
    const roleDocs = await Role.find({ _id: { $in: roleIds } }).select('name').lean();
    roleDocs.forEach((r) => roleNameById.set(String(r._id), r.name));
  }
  const roleLabel = (u) =>
    (u.roleIds || []).map((id) => roleNameById.get(String(id))).filter(Boolean).join(', ') || null;

  return res.send({
    ...result,
    results: rows.map((u) =>
      serializeContact(viewer, { ...(u.toJSON ? u.toJSON() : u), roleName: roleLabel(u) }, { reason })
    ),
  });
});

const lookupUserByEmail = catchAsync(async (req, res) => {
  const viewer = req.user;
  const viewerId = getUserId(req);
  const normalized = String(req.query.email).trim().toLowerCase();

  // Service-level daily cap, on top of the two per-minute middleware limiters. Spec §6.
  if ((await dailyLookupCount(viewerId)) >= LOOKUP_DAILY_CAP) {
    return res
      .status(httpStatus.TOO_MANY_REQUESTS)
      .json({ message: 'Too many lookups. Please try again later.' });
  }

  const emailHash = hashEmail(normalized);
  const user = await lookupExactEmail(viewerId, normalized);

  // Audited on BOTH outcomes, from one place, after the single query — so no obviously divergent
  // processing path exists between hit and miss. Not a claim of timing-attack resistance. Spec §3.2.
  await recordLookup(req, { emailHash, outcome: user ? 'hit' : 'miss' });

  if (!user) {
    return res
      .status(httpStatus.NOT_FOUND)
      .json({ message: 'No registered user found with that email' });
  }

  return res.send({
    contact: serializeContact(viewer, user, { reason: CONTACT_REASONS.EXACT_EMAIL_LOOKUP }),
  });
});

const addParticipants = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.addParticipants(req.params.id, userId, req.body, req.user);
  await emitConversationUpdated(req.params.id);
  res.status(httpStatus.OK).send(conv);
});

const removeParticipant = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.removeParticipant(req.params.id, userId, req.params.userId);
  if (conv) await emitConversationUpdated(req.params.id);
  if (conv) res.send(conv);
  else res.status(httpStatus.NO_CONTENT).send();
});

const setParticipantRole = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.setParticipantRole(req.params.id, userId, req.params.userId, req.body);
  await emitConversationUpdated(req.params.id);
  res.send(conv);
});

const updateGroupName = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.updateGroupName(req.params.id, userId, req.body);
  await emitConversationUpdated(req.params.id);
  res.send(conv);
});

const setConversationPreferences = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.setConversationPreferences(req.params.id, userId, req.body);
  try {
    const io = getIO();
    if (io) {
      io.to(`user:${String(userId)}`).emit('conversation_updated', {
        conversationId: String(req.params.id),
        userId: String(userId),
        muted: conv.muted,
        pinned: conv.pinned,
      });
    }
  } catch (err) {
    logger.warn(`conversation preferences notify failed: ${err.message}`);
  }
  res.send(conv);
});

const GROUP_AVATAR_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const uploadGroupAvatar = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const file = req.file;
  if (!file) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'No image provided' });
  }
  if (!GROUP_AVATAR_MIMES.includes(file.mimetype)) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'Image must be JPEG, PNG, WebP, or GIF' });
  }
  const uploadResult = await uploadFileToS3(file, userId, 'chat-group-avatars');
  const conv = await chatService.setGroupConversationAvatar(req.params.id, userId, uploadResult);
  await emitConversationUpdated(req.params.id);
  res.send(conv);
});

export {
  listConversations,
  listConversationPreferences,
  createConversation,
  getConversation,
  getMessages,
  getConversationMessage,
  getConversationTimeline,
  sendMessage,
  uploadAndSendMessage,
  deleteMessage,
  forwardMessage,
  reactToMessage,
  markAsDelivered,
  markAsRead,
  listCalls,
  listCallsForConversation,
  getActiveCallForConversation,
  getCall,
  initiateCall,
  initiateGroupCall,
  updateCall,
  startChatCallRecording,
  endCallByRoom,
  searchUsers,
  lookupUserByEmail,
  getSocketToken,
  addParticipants,
  removeParticipant,
  setParticipantRole,
  updateGroupName,
  setConversationPreferences,
  uploadGroupAvatar,
  deleteConversation,
};
