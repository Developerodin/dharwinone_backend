import Joi from 'joi';
import { objectId } from './custom.validation.js';

const conversationIdParam = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const listConversations = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(50),
  }),
};

const createConversation = {
  body: Joi.object().keys({
    type: Joi.string().valid('direct', 'group').required(),
    participantIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
    name: Joi.string().trim().allow(''),
    description: Joi.string().trim().max(500).allow(''),
  }),
};

const getMessages = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    before: Joi.string().custom(objectId),
    limit: Joi.number().integer().min(1).max(100),
  }),
};

const attachmentItem = Joi.object().keys({
  url: Joi.string().uri().required(),
  key: Joi.string().allow(''),
  originalName: Joi.string().allow(''),
  size: Joi.number().min(0),
  mimeType: Joi.string().allow(''),
});

const sendMessage = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      content: Joi.string().trim().max(10000).allow(''),
      type: Joi.string().valid('text', 'image', 'file', 'audio', 'video'),
      attachments: Joi.array().items(attachmentItem).min(1).max(10),
      replyTo: Joi.string().custom(objectId),
    })
    .or('content', 'attachments'),
};

const initiateCall = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    callType: Joi.string().valid('audio', 'video').default('audio'),
  }),
};

const listCalls = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
  }),
};

const callIdParam = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const updateCall = {
  params: callIdParam.params,
  body: Joi.object()
    .keys({
      status: Joi.string().valid('initiated', 'ringing', 'ongoing', 'completed', 'missed', 'declined'),
      duration: Joi.number().min(0),
      recordRoomJoin: Joi.boolean().valid(true),
    })
    .or('status', 'duration', 'recordRoomJoin'),
};

const deleteMessage = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
    msgId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    deleteFor: Joi.string().valid('me', 'everyone').default('me'),
  }),
};

const forwardMessage = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
    msgId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      targetConversationId: Joi.string().custom(objectId),
      targetConversationIds: Joi.array().items(Joi.string().custom(objectId)).min(1).max(25),
    })
    .or('targetConversationId', 'targetConversationIds'),
};

const reactToMessage = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
    msgId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    emoji: Joi.string().trim().max(10).default('👍'),
  }),
};

const searchUsers = {
  query: Joi.object().keys({
    search: Joi.string().trim().min(1).max(100),
    limit: Joi.number().integer().min(1).max(250),
    page: Joi.number().integer().min(1),
  }),
};

const addParticipants = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    participantIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
  }),
};

const removeParticipant = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
    userId: Joi.string().custom(objectId).required(),
  }),
};

const setParticipantRole = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
    userId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    role: Joi.string().valid('admin', 'member').required(),
  }),
};

const updateGroupName = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().max(100).allow(''),
      description: Joi.string().trim().max(500).allow(''),
    })
    .min(1),
};

const setConversationPreferences = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      muted: Joi.boolean(),
      pinned: Joi.boolean(),
    })
    .or('muted', 'pinned'),
};

const startChatCallRecording = {
  params: callIdParam.params,
};

export {
  conversationIdParam,
  callIdParam,
  deleteMessage,
  forwardMessage,
  reactToMessage,
  listConversations,
  createConversation,
  getMessages,
  sendMessage,
  initiateCall,
  listCalls,
  updateCall,
  searchUsers,
  addParticipants,
  removeParticipant,
  setParticipantRole,
  updateGroupName,
  setConversationPreferences,
  startChatCallRecording,
};
