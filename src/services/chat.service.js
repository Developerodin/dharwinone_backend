import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import Conversation from '../models/conversation.model.js';
import Message from '../models/message.model.js';
import ChatCall from '../models/chatCall.model.js';
import * as livekitService from './livekit.service.js';
import Recording from '../models/recording.model.js';
import { generatePresignedDownloadUrl, generatePresignedRecordingPlaybackUrl } from '../config/s3.js';

const ensureParticipant = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found');
  const isParticipant = conv.participants?.some((p) => p.user.toString() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');
  return conv;
};

const ensureAdmin = async (conversationId, userId) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type !== 'group') throw new ApiError(httpStatus.BAD_REQUEST, 'Not a group');
  const participant = conv.participants?.find((p) => p.user.toString() === userId);
  const role = participant?.role || (conv.createdBy?.toString() === userId ? 'admin' : 'member');
  if (role !== 'admin') throw new ApiError(httpStatus.FORBIDDEN, 'Admin only');
  return conv;
};

const isCreator = (conv, userId) => conv.createdBy?.toString() === userId;

const getConversationParticipantIds = async (conversationId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) return [];
  return (conv.participants || []).map((p) => p.user.toString());
};

const listConversations = async (userId, { page = 1, limit = 20 }) => {
  const skip = (page - 1) * limit;
  const convs = await Conversation.find({ 'participants.user': new mongoose.Types.ObjectId(userId) })
    .sort({ lastMessageAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('participants.user', 'name email')
    .populate('createdBy', 'name email')
    .lean();

  const seenGroupKeys = new Set();
  const result = [];
  for (const c of convs) {
    if (c.type === 'group') {
      const participantIds = (c.participants || [])
        .map((p) => p.user?._id?.toString?.())
        .filter(Boolean)
        .sort()
        .join(',');
      const groupKey = `${c.name || 'Group'}|${participantIds}`;
      if (seenGroupKeys.has(groupKey)) continue;
      seenGroupKeys.add(groupKey);
    }

    const lastMsg = await Message.findOne({ conversation: c._id }).sort({ createdAt: -1 }).populate('sender', 'name').lean();
    const myParticipant = c.participants?.find((p) => p.user._id.toString() === userId);
    const unreadCount = myParticipant?.lastReadAt
      ? await Message.countDocuments({ conversation: c._id, createdAt: { $gt: myParticipant.lastReadAt }, sender: { $ne: userId } })
      : await Message.countDocuments({ conversation: c._id, sender: { $ne: userId } });

    const otherParticipants = (c.participants || []).filter((p) => p.user._id.toString() !== userId);
    const displayName = c.type === 'group' ? (c.name || 'Group') : otherParticipants[0]?.user?.name || 'Unknown';

    result.push({
      ...c,
      id: c._id?.toString(),
      displayName,
      lastMessage: lastMsg
        ? {
            content: lastMsg.type !== 'text' ? (lastMsg.type === 'image' ? '📷 Image' : '📎 File') : lastMsg.content,
            sender: lastMsg.sender?.name,
            createdAt: lastMsg.createdAt,
          }
        : null,
      unreadCount,
    });
  }
  const total = await Conversation.countDocuments({ 'participants.user': new mongoose.Types.ObjectId(userId) });
  return { results: result, page, limit, totalPages: Math.ceil(total / limit) };
};

const createConversation = async (userId, { type, participantIds, name }) => {
  const ids = [...new Set(participantIds.map((id) => id.toString()))];
  if (type === 'direct' && ids.length !== 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Direct conversation requires exactly one other participant');
  }
  if (type === 'group' && ids.length < 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group requires at least one other participant');
  }

  const allParticipantIds = [userId, ...ids].map((id) => new mongoose.Types.ObjectId(id));
  if (type === 'direct') {
    const existing = await Conversation.findOne({
      type: 'direct',
      $and: allParticipantIds.map((id) => ({ 'participants.user': id })),
    })
      .populate('participants.user', 'name email')
      .lean();
    if (existing) return { ...existing, id: existing._id?.toString() };
  }

  if (type === 'group') {
    const groups = await Conversation.find({
      type: 'group',
      'participants.user': { $all: allParticipantIds },
      'participants.0': { $exists: true },
    })
      .populate('participants.user', 'name email')
      .populate('createdBy', 'name email')
      .lean();
    const existing = groups.find((g) => {
      const gIds = (g.participants || []).map((p) => p.user?._id?.toString?.()).filter(Boolean);
      return gIds.length === allParticipantIds.length && allParticipantIds.every((id) => gIds.includes(id.toString()));
    });
    if (existing) return { ...existing, id: existing._id?.toString() };
  }

  const participants = allParticipantIds.map((id, idx) => ({
    user: id,
    lastReadAt: null,
    ...(type === 'group' && idx === 0 ? { role: 'admin' } : {}),
  }));
  const conv = await Conversation.create({
    type,
    participants,
    name: type === 'group' ? name || 'Group' : undefined,
    createdBy: userId,
  });
  return conv.populate(['participants.user', 'createdBy']);
};

const getConversation = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  const conv = await Conversation.findById(conversationId)
    .populate('participants.user', 'name email')
    .populate('createdBy', 'name email')
    .lean();
  const result = { ...conv, id: conv._id?.toString() };
  return result;
};

const getMessages = async (conversationId, userId, { before, limit = 50 }) => {
  await ensureParticipant(conversationId, userId);
  const filter = {
    conversation: new mongoose.Types.ObjectId(conversationId),
    $or: [
      { deletedAt: null },
      { deletedFor: 'everyone' },
      { deletedFor: 'me', deletedBy: { $ne: new mongoose.Types.ObjectId(userId) } },
    ],
  };
  if (before) {
    const beforeDoc = await Message.findById(before);
    if (beforeDoc) filter.createdAt = { $lt: beforeDoc.createdAt };
  }
  const messages = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('sender', 'name email')
    .populate({ path: 'replyTo', select: 'content type sender createdAt', populate: { path: 'sender', select: 'name' } })
    .populate('reactions.user', 'name')
    .lean();
  const reversed = messages.reverse();
  // Regenerate presigned URLs for attachments (expire after 1h; old messages need fresh URLs)
  for (const m of reversed) {
    if (m.attachments?.length) {
      m.attachments = await Promise.all(
        m.attachments.map(async (a) => {
          if (a.key) {
            try {
              const url = await generatePresignedDownloadUrl(a.key, 3600);
              return { ...a, url };
            } catch {
              return a;
            }
          }
          return a;
        })
      );
    }
  }
  return reversed.map((m) => ({ ...m, id: m._id?.toString() }));
};

const createMessage = async (conversationId, userId, { content, type, attachments, replyTo }) => {
  await ensureParticipant(conversationId, userId);

  const msgType = type || (attachments?.length ? 'file' : 'text');
  const msgData = {
    conversation: conversationId,
    sender: userId,
    content: (content || '').trim() || (msgType !== 'text' ? '' : ''),
    type: msgType,
  };

  if (replyTo) {
    const replyMsg = await Message.findOne({ _id: replyTo, conversation: conversationId });
    if (replyMsg) msgData.replyTo = replyTo;
  }
  if (attachments && attachments.length > 0) {
    msgData.attachments = attachments.map((a) => ({
      url: a.url,
      key: a.key,
      originalName: a.originalName,
      size: a.size || 0,
      mimeType: a.mimeType || '',
    }));
    if (!msgData.content && msgType === 'image') msgData.content = '📷 Image';
    if (!msgData.content && msgType === 'file') msgData.content = '📎 File';
    if (!msgData.content && msgType === 'audio') msgData.content = '🎤 Voice note';
  }

  const msg = await Message.create(msgData);
  await Conversation.findByIdAndUpdate(conversationId, { lastMessageAt: new Date() });
  const populated = await msg.populate('sender', 'name email');
  const result = populated.toObject();
  result.id = result._id?.toString();
  return result;
};

const deleteMessage = async (conversationId, messageId, userId, { deleteFor }) => {
  await ensureParticipant(conversationId, userId);
  const msg = await Message.findOne({ _id: messageId, conversation: conversationId }).lean();
  if (!msg) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');
  const isSender = msg.sender.toString() === userId;
  if (!isSender) throw new ApiError(httpStatus.FORBIDDEN, 'Only the sender can delete a message');
  const update = {
    deletedAt: new Date(),
    deletedFor: deleteFor || 'me',
    deletedBy: userId,
  };
  await Message.findByIdAndUpdate(messageId, { $set: update });
  const updated = await Message.findById(messageId)
    .populate('sender', 'name email')
    .populate({ path: 'replyTo', select: 'content type sender', populate: { path: 'sender', select: 'name' } })
    .lean();
  const result = { ...updated, id: updated._id?.toString() };
  return result;
};

const reactToMessage = async (conversationId, messageId, userId, { emoji }) => {
  await ensureParticipant(conversationId, userId);
  const msg = await Message.findOne({ _id: messageId, conversation: conversationId });
  if (!msg) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');
  const reactions = (msg.reactions || []).filter((r) => r.user.toString() !== userId);
  if (emoji) {
    reactions.push({ user: userId, emoji: emoji || '👍' });
  }
  msg.reactions = reactions;
  await msg.save();
  const populated = await Message.findById(messageId)
    .populate('sender', 'name email')
    .populate({ path: 'replyTo', select: 'content type sender', populate: { path: 'sender', select: 'name' } })
    .populate('reactions.user', 'name')
    .lean();
  const result = { ...populated, id: populated._id?.toString() };
  return result;
};

const markAsRead = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  const now = new Date();
  await Conversation.updateOne(
    { _id: conversationId, 'participants.user': userId },
    { $set: { 'participants.$.lastReadAt': now } }
  );
  // Also add userId to readBy for recent unread messages
  await Message.updateMany(
    {
      conversation: conversationId,
      sender: { $ne: userId },
      readBy: { $ne: userId },
    },
    { $addToSet: { readBy: userId } }
  );
  return { success: true };
};

const listCallsForConversation = async (conversationId, userId, { limit = 50 } = {}) => {
  await ensureParticipant(conversationId, userId);
  const calls = await ChatCall.find({
    conversation: conversationId,
    $or: [{ caller: userId }, { participants: userId }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('caller', 'name email')
    .lean();
  return calls.map((c) => ({ ...c, id: c._id?.toString() }));
};

const listCalls = async (userId, { page = 1, limit = 20, isAdmin = false }) => {
  const skip = (page - 1) * limit;
  const filter = isAdmin ? {} : { $or: [{ caller: userId }, { participants: userId }] };
  const calls = await ChatCall.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('conversation')
    .lean();
  const total = await ChatCall.countDocuments(filter);
  const results = [];
  for (const c of calls) {
    const item = { ...c, id: c._id?.toString() };
    if (c.recordingId) {
      try {
        const rec = await Recording.findById(c.recordingId).lean();
        if (rec && rec.status === 'completed' && rec.filePath) {
          item.recordingUrl = await generatePresignedRecordingPlaybackUrl(rec.filePath, 3600);
        }
      } catch {
        item.recordingUrl = null;
      }
    }
    results.push(item);
  }
  return {
    results,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

const createCall = async (conversationId, userId, { callType }) => {
  const conv = await ensureParticipant(conversationId, userId);
  const roomName = `chat-${conversationId}-${Date.now()}`;
  const otherUserIds = (conv.participants || []).filter((p) => p.user.toString() !== userId).map((p) => p.user);
  const call = await ChatCall.create({
    conversation: conversationId,
    caller: userId,
    participants: [userId, ...otherUserIds],
    callType: callType || 'audio',
    status: 'initiated',
    livekitRoom: roomName,
    startedAt: new Date(),
  });
  const populated = await call.populate(['caller', 'participants', 'conversation']);
  return { call: populated, roomName };
};

const updateCall = async (callId, userId, { status, duration }) => {
  const call = await ChatCall.findById(callId).lean();
  if (!call) throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  const isParticipant = call.caller.toString() === userId || call.participants?.some((p) => p.toString() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');

  const update = {};
  if (status) update.status = status;
  if (duration != null) update.duration = duration;
  if (status === 'completed' || status === 'missed' || status === 'declined' || status === 'ended') {
    update.endedAt = new Date();
  }
  const updated = await ChatCall.findByIdAndUpdate(callId, { $set: update }, { new: true }).populate('caller participants');
  return updated;
};

/**
 * Start LiveKit Egress recording for an in-app chat call.
 * User must be a participant. Call must have livekitRoom and be ongoing.
 */
const startChatCallRecording = async (callId, userId) => {
  const call = await ChatCall.findById(callId).lean();
  if (!call) throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  const isParticipant = call.caller.toString() === userId || call.participants?.some((p) => p?.toString?.() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');
  if (!call.livekitRoom || !call.livekitRoom.trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Call has no LiveKit room');
  }
  const result = await livekitService.startRecording(call.livekitRoom);
  return result;
};

/**
 * Get active call for conversation - only returns if LiveKit room has participants (call is truly active)
 */
const getActiveCallForConversation = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  const calls = await ChatCall.find({
    conversation: conversationId,
    $or: [{ caller: userId }, { participants: userId }],
    status: { $in: ['initiated', 'ringing', 'ongoing'] },
    livekitRoom: { $exists: true, $ne: '' },
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('conversation')
    .lean();

  for (const c of calls) {
    if (!c.livekitRoom) continue;
    const count = await livekitService.getRoomParticipantCount(c.livekitRoom);
    if (count > 0) {
      return {
        ...c,
        id: c._id?.toString?.(),
        liveParticipantCount: count,
      };
    }
  }
  return null;
};

const endCallByRoom = async (roomName, userId) => {
  const call = await ChatCall.findOne({ livekitRoom: roomName }).lean();
  if (!call) return null;
  const isParticipant = call.caller.toString() === userId || call.participants?.some((p) => p.toString() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');
  const endedAt = new Date();
  const startedAt = call.startedAt ? new Date(call.startedAt) : new Date(call.createdAt);
  const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  await ChatCall.findByIdAndUpdate(call._id, {
    $set: { status: 'completed', endedAt, duration },
  });
  const conversationId = call.conversation?.toString?.();
  if (roomName.startsWith('chat-')) {
    await livekitService.disconnectAllParticipants(roomName).catch(() => {});
  }
  return { success: true, conversationId, roomName };
};

const addParticipants = async (conversationId, userId, { participantIds }) => {
  await ensureAdmin(conversationId, userId);
  const ids = [...new Set((participantIds || []).map((id) => id.toString()))];
  if (!ids.length) throw new ApiError(httpStatus.BAD_REQUEST, 'participantIds required');

  const conv = await Conversation.findById(conversationId).lean();
  const existingIds = (conv.participants || []).map((p) => p.user.toString());
  const toAdd = ids.filter((id) => !existingIds.includes(id));
  if (!toAdd.length) return getConversation(conversationId, userId);

  const newParticipants = toAdd.map((id) => ({
    user: new mongoose.Types.ObjectId(id),
    lastReadAt: null,
    role: 'member',
  }));
  await Conversation.findByIdAndUpdate(conversationId, {
    $push: { participants: { $each: newParticipants } },
  });
  return getConversation(conversationId, userId);
};

const removeParticipant = async (conversationId, userId, targetUserId) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type !== 'group') throw new ApiError(httpStatus.BAD_REQUEST, 'Not a group');

  const isSelf = targetUserId === userId;
  if (isSelf) {
    const participants = (conv.participants || []).filter((p) => p.user.toString() !== userId);
    if (participants.length === 0) {
      await Conversation.findByIdAndDelete(conversationId);
      return null;
    }
    await Conversation.findByIdAndUpdate(conversationId, {
      $pull: { participants: { user: new mongoose.Types.ObjectId(userId) } },
    });
    return null;
  }

  await ensureAdmin(conversationId, userId);
  if (conv.createdBy?.toString() === targetUserId) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot remove group creator');
  }
  const targetParticipant = conv.participants?.find((p) => p.user.toString() === targetUserId);
  const targetRole = targetParticipant?.role || (conv.createdBy?.toString() === targetUserId ? 'admin' : 'member');
  if (!isCreator(conv, userId) && targetRole === 'admin') {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only creator can remove admins');
  }
  await Conversation.findByIdAndUpdate(conversationId, {
    $pull: { participants: { user: new mongoose.Types.ObjectId(targetUserId) } },
  });
  return getConversation(conversationId, userId);
};

const setParticipantRole = async (conversationId, userId, targetUserId, { role }) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type !== 'group') throw new ApiError(httpStatus.BAD_REQUEST, 'Not a group');
  if (!isCreator(conv, userId)) throw new ApiError(httpStatus.FORBIDDEN, 'Only creator can change roles');
  if (conv.createdBy?.toString() === targetUserId) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot change creator role');
  }
  if (!['admin', 'member'].includes(role)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'role must be admin or member');
  }

  await Conversation.updateOne(
    { _id: conversationId, 'participants.user': new mongoose.Types.ObjectId(targetUserId) },
    { $set: { 'participants.$.role': role } }
  );
  return getConversation(conversationId, userId);
};

const updateGroupName = async (conversationId, userId, { name }) => {
  await ensureAdmin(conversationId, userId);
  const trimmed = (name || '').trim() || 'Group';
  await Conversation.findByIdAndUpdate(conversationId, { $set: { name: trimmed } });
  return getConversation(conversationId, userId);
};

export {
  listConversations,
  createConversation,
  getConversation,
  getConversationParticipantIds,
  getMessages,
  createMessage,
  deleteMessage,
  reactToMessage,
  markAsRead,
  listCalls,
  listCallsForConversation,
  getActiveCallForConversation,
  endCallByRoom,
  createCall,
  updateCall,
  startChatCallRecording,
  ensureParticipant,
  addParticipants,
  removeParticipant,
  setParticipantRole,
  updateGroupName,
};
