import Joi from 'joi';
import { objectId } from './custom.validation.js';

/** Re-use mail schemas from email.validation where identical */
export {
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
} from './email.validation.js';

const listOutlookAccounts = {};

const getMicrosoftAuthUrl = {};

const microsoftCallback = {
  query: Joi.object()
    .keys({
      code: Joi.string().required(),
      state: Joi.string().required(),
    })
    .unknown(true),
};

const disconnectOutlookAccount = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

export { listOutlookAccounts, getMicrosoftAuthUrl, microsoftCallback, disconnectOutlookAccount };
