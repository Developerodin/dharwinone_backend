import Joi from 'joi';
import { objectId } from './custom.validation.js';

const listGmailAccounts = {};

/** GET /v1/email/connection-policy — no query/body */
const connectionPolicy = {};

const getGoogleAuthUrl = {};

const googleCallback = {
  query: Joi.object()
    .keys({
      code: Joi.string().required(),
      state: Joi.string().required(),
    })
    .unknown(true),
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

const generateDraft = {
  body: Joi.object().keys({
    tone: Joi.string().trim().valid('professional', 'friendly', 'formal', 'persuasive', 'empathetic').required(),
    prompt: Joi.string().trim().min(3).max(2000).required(),
    subject: Joi.string().trim().max(500).allow('').default(''),
    context: Joi.string().trim().max(4000).allow('').default(''),
    recipientName: Joi.string().trim().max(200).allow('').default(''),
    length: Joi.string().trim().valid('short', 'medium', 'long').default('medium'),
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

/** Same body/params as single reply */
const replyAllMessage = replyMessage;

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

const MAX_EMAIL_HTML = 65536;
const htmlBodyField = Joi.string().max(MAX_EMAIL_HTML).allow('');

const listEmailTemplates = {};

const createEmailTemplate = {
  body: Joi.object().keys({
    title: Joi.string().trim().min(1).max(200).required(),
    subject: Joi.string().trim().max(500).allow(''),
    bodyHtml: htmlBodyField.required(),
    isShared: Joi.boolean(),
  }),
};

const updateEmailTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().trim().min(1).max(200),
      subject: Joi.string().trim().max(500).allow(''),
      bodyHtml: htmlBodyField,
      isShared: Joi.boolean(),
    })
    .min(1),
};

const deleteEmailTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
};

const getEmailSignature = {};

const patchEmailSignature = {
  body: Joi.object()
    .keys({
      html: htmlBodyField,
      enabled: Joi.boolean(),
    })
    .min(1),
};

const adminListEmailTemplates = {
  query: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
};

const adminCreateEmailTemplate = {
  body: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
    title: Joi.string().trim().min(1).max(200).required(),
    subject: Joi.string().trim().max(500).allow(''),
    bodyHtml: htmlBodyField.required(),
    isShared: Joi.boolean(),
  }),
};

const adminGetEmailSignature = adminListEmailTemplates;

const adminUpdateEmailTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().trim().min(1).max(200),
      subject: Joi.string().trim().max(500).allow(''),
      bodyHtml: htmlBodyField,
      isShared: Joi.boolean(),
    })
    .min(1),
};

const adminDeleteEmailTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
};

const adminPatchEmailSignature = {
  body: Joi.object()
    .keys({
      userId: Joi.string().custom(objectId).required(),
      html: htmlBodyField,
      enabled: Joi.boolean(),
    })
    .min(1),
};

export {
  listGmailAccounts,
  connectionPolicy,
  getGoogleAuthUrl,
  googleCallback,
  disconnectAccount,
  listMessages,
  listThreads,
  getThread,
  getMessage,
  getAttachment,
  generateDraft,
  sendMessage,
  replyMessage,
  replyAllMessage,
  forwardMessage,
  modifyMessage,
  batchModifyMessages,
  batchModifyThreads,
  trashThreads,
  deleteMessage,
  listLabels,
  createLabel,
  listEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  getEmailSignature,
  patchEmailSignature,
  adminListEmailTemplates,
  adminCreateEmailTemplate,
  adminGetEmailSignature,
  adminUpdateEmailTemplate,
  adminDeleteEmailTemplate,
  adminPatchEmailSignature,
};
