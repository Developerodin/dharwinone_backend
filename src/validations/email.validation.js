import Joi from 'joi';
import { objectId } from './custom.validation.js';

const accountIdParam = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const listAccounts = {};

const getGoogleAuthUrl = {};

const googleCallback = {
  query: Joi.object()
    .keys({
      code: Joi.string().required(),
      state: Joi.string().required(),
    })
    .unknown(true), // Allow extra params from Google: iss, scope, authuser, hd, prompt, etc.
};

const listMessages = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    labelId: Joi.string().allow('').optional(),
    pageToken: Joi.string().allow(''),
    pageSize: Joi.number().integer().min(1).max(100).default(20),
    q: Joi.string().allow('').default(''),
  }),
};

const listThreads = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    labelId: Joi.string().allow('').optional(),
    pageToken: Joi.string().allow(''),
    pageSize: Joi.number().integer().min(1).max(100).default(20),
    q: Joi.string().allow('').default(''),
  }),
};

const getThread = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

const getMessage = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

const getAttachment = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    messageId: Joi.string().required(),
    attachmentId: Joi.string().required(),
  }),
};

const sendMessage = {
  body: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    to: Joi.alternatives().try(Joi.string().email(), Joi.array().items(Joi.string().email())).required(),
    cc: Joi.alternatives().try(Joi.string().email(), Joi.array().items(Joi.string().email())).optional(),
    bcc: Joi.alternatives().try(Joi.string().email(), Joi.array().items(Joi.string().email())).optional(),
    subject: Joi.string().allow('').default(''),
    html: Joi.string().allow('').default(''),
    attachments: Joi.array()
      .items(
        Joi.object().keys({
          filename: Joi.string().required(),
          content: Joi.alternatives().try(Joi.string(), Joi.binary()).required(),
          mimeType: Joi.string().optional(),
        })
      )
      .optional()
      .default([]),
  }),
};

const replyMessage = {
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
  body: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    html: Joi.string().allow('').default(''),
    attachments: Joi.array()
      .items(
        Joi.object().keys({
          filename: Joi.string().required(),
          content: Joi.alternatives().try(Joi.string(), Joi.binary()).required(),
          mimeType: Joi.string().optional(),
        })
      )
      .optional()
      .default([]),
  }),
};

const forwardMessage = {
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
  body: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    to: Joi.alternatives().try(Joi.string().email(), Joi.array().items(Joi.string().email())).required(),
    html: Joi.string().allow('').default(''),
    attachments: Joi.array().items(Joi.object()).optional().default([]),
  }),
};

const modifyMessage = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
  body: Joi.object().keys({
    addLabelIds: Joi.array().items(Joi.string()).optional().default([]),
    removeLabelIds: Joi.array().items(Joi.string()).optional().default([]),
  }),
};

const batchModifyMessages = {
  body: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    messageIds: Joi.array().items(Joi.string()).required().min(1),
    addLabelIds: Joi.array().items(Joi.string()).optional().default([]),
    removeLabelIds: Joi.array().items(Joi.string()).optional().default([]),
  }),
};

const batchModifyThreads = {
  body: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    threadIds: Joi.array().items(Joi.string()).required().min(1),
    addLabelIds: Joi.array().items(Joi.string()).optional().default([]),
    removeLabelIds: Joi.array().items(Joi.string()).optional().default([]),
  }),
};

const trashThreads = {
  body: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
    threadIds: Joi.array().items(Joi.string()).required().min(1),
  }),
};

const deleteMessage = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

const listLabels = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
};

const createLabel = {
  query: Joi.object().keys({
    accountId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    name: Joi.string().trim().min(1).max(255).required(),
  }),
};

const disconnectAccount = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

export {
  listAccounts,
  getGoogleAuthUrl,
  googleCallback,
  disconnectAccount,
  listMessages,
  listThreads,
  getThread,
  getMessage,
  getAttachment,
  sendMessage,
  replyMessage,
  forwardMessage,
  modifyMessage,
  batchModifyMessages,
  batchModifyThreads,
  trashThreads,
  deleteMessage,
  listLabels,
  createLabel,
};
