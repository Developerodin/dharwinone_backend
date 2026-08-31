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
    type: Joi.string().valid('direct', 'group').optional(),
  }),
};

const createConversation = {
  body: Joi.object()
    .keys({
      type: Joi.string().valid('direct', 'group').required(),
      participantIds: Joi.array().items(Joi.string().custom(objectId)).min(1),
      name: Joi.string().trim().allow(''),
      description: Joi.string().trim().max(500).allow(''),
      /**
       * Restricted-role path: the client sends the ADDRESS, never the id it got back from
       * /users/lookup. The server re-resolves it, because Mongo ObjectIds embed a timestamp and
       * counter and are partially guessable — an id-accepting write path would be a quieter
       * enumeration oracle than the lookup endpoint. Direct conversations only; group creation
       * remains a directory capability. Spec §5.4.
       */
      email: Joi.string().trim().lowercase().email().max(254).when('type', {
        is: 'direct',
        then: Joi.optional(),
        otherwise: Joi.forbidden(),
      }),
    })
    // Exactly one addressing mode for a direct conversation. Accepting both and letting `email`
    // silently win leaves an ambiguous payload whose behaviour is invisible from the request:
    // { type:'direct', participantIds:['<someone>'], email:'<someone-else>' } would create a chat
    // with neither the caller's apparent intent nor an error.
    .oxor('participantIds', 'email')
    .when(Joi.object({ type: Joi.valid('direct') }).unknown(), {
      then: Joi.object().or('participantIds', 'email'),
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

/**
 * Exact-email lookup. Joi's .email() rejects partials such as "harsh@" or "harsh" AT THE
 * VALIDATOR, before any query exists — FR-09 and FR-12 are enforced by shape, not by convention.
 * Spec §3.2.
 */
const lookupUserByEmail = {
  query: Joi.object().keys({
    email: Joi.string().trim().lowercase().email().max(254).required(),
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

const initiateGroupCall = {
  body: Joi.object().keys({
    participantIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
    callType: Joi.string().valid('audio', 'video').default('audio'),
  }),
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
  lookupUserByEmail,
  addParticipants,
  removeParticipant,
  setParticipantRole,
  updateGroupName,
  setConversationPreferences,
  initiateGroupCall,
  startChatCallRecording,
};
