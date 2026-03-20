import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as chatService from '../services/chat.service.js';
import { emitNewMessage, emitIncomingCall, emitCallEnded, emitMessageDeleted, emitMessageReacted, emitConversationUpdated, emitConversationDeleted } from '../services/chatSocket.service.js';
import { queryUsers } from '../services/user.service.js';
import { uploadFileToS3 } from '../services/upload.service.js';

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
  const result = await chatService.listConversations(userId, { page, limit });
  res.send(result);
});

const createConversation = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.createConversation(userId, req.body);
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

const sendMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const msg = await chatService.createMessage(req.params.id, userId, req.body);
  await emitNewMessage(req.params.id, msg);
  res.status(httpStatus.CREATED).send(msg);
});

const uploadAndSendMessage = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const files = req.files || (req.file ? [req.file] : []);
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
  const msgType = isImage ? 'image' : isAudio ? 'audio' : 'file';
  const content = req.body?.content || '';
  const replyTo = req.body?.replyTo || undefined;

  const msg = await chatService.createMessage(req.params.id, userId, {
    content: msgType === 'audio' ? '🎤 Voice note' : content,
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
  emitMessageDeleted(req.params.id, req.params.msgId, deleteFor);
  res.send(msg);
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

const markAsRead = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  await chatService.markAsRead(req.params.id, userId);
  res.send({ success: true });
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
  const calls = await chatService.listCallsForConversation(req.params.id, userId, { limit });
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

  emitIncomingCall(req.params.id, {
    conversationId: req.params.id,
    callId: result.call?.id || result.call?._id?.toString(),
    roomName: result.roomName,
    callType: callType || 'audio',
    caller: { id: userId, name: req.user?.name, email: req.user?.email },
    conversationType,
    ...(groupName !== undefined && { groupName }),
  });

  res.status(httpStatus.CREATED).send(result);
});

const startChatCallRecording = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const result = await chatService.startChatCallRecording(req.params.id, userId);
  res.status(httpStatus.OK).send(result);
});

const updateCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const call = await chatService.updateCall(req.params.id, userId, req.body);
  res.send(call);
});

const endCallByRoom = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const { roomName } = req.body;
  if (!roomName) return res.status(400).json({ message: 'roomName required' });
  const result = await chatService.endCallByRoom(roomName, userId);
  if (result?.conversationId) {
    emitCallEnded(result.conversationId, roomName);
  }
  res.send({ success: true });
});

const searchUsers = catchAsync(async (req, res) => {
  const search = req.query.search?.trim();
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
  const result = await queryUsers(
    { search: search || undefined, status: 'active' },
    { limit, page: 1, sortBy: 'name:asc' }
  );
  res.send(result);
});

const addParticipants = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const conv = await chatService.addParticipants(req.params.id, userId, req.body);
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
  createConversation,
  getConversation,
  getMessages,
  sendMessage,
  uploadAndSendMessage,
  deleteMessage,
  reactToMessage,
  markAsRead,
  listCalls,
  listCallsForConversation,
  getActiveCallForConversation,
  initiateCall,
  updateCall,
  startChatCallRecording,
  endCallByRoom,
  searchUsers,
  getSocketToken,
  addParticipants,
  removeParticipant,
  setParticipantRole,
  updateGroupName,
  uploadGroupAvatar,
  deleteConversation,
};
