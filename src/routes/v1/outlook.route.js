import express from 'express';
import config from '../../config/config.js';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as outlookValidation from '../../validations/outlook.validation.js';
import * as outlookController from '../../controllers/outlook.controller.js';
import logger from '../../config/logger.js';

const router = express.Router();

function microsoftCallbackGuard(req, res, next) {
  logger.info('[Outlook] Callback received query: %o', req.query);
  if (!req.query?.code || !req.query?.state) {
    if (req.query?.error) {
      logger.error('[Outlook] Microsoft returned error: %s (%s)', req.query.error, req.query.error_description || 'no description');
    }
    return res.redirect(`${config.frontendBaseUrl}/communication/email?error=missing_callback_params`);
  }
  next();
}
router.get(
  ['/auth/microsoft/callback', '/auth/microsoft/callback/'],
  microsoftCallbackGuard,
  validate(outlookValidation.microsoftCallback),
  outlookController.microsoftCallback
);

router.use(auth());

router.get('/accounts', requirePermissions('emails.read'), validate(outlookValidation.listOutlookAccounts), outlookController.listOutlookAccounts);
router.get('/auth/microsoft', requirePermissions('emails.manage'), validate(outlookValidation.getMicrosoftAuthUrl), outlookController.getMicrosoftAuthUrl);
router.post(
  '/auth/microsoft/connect',
  requirePermissions('emails.manage'),
  validate(outlookValidation.connectMicrosoftAccount),
  outlookController.connectMicrosoftAccount
);
router.delete(
  '/accounts/:id',
  requirePermissions('emails.manage'),
  validate(outlookValidation.disconnectOutlookAccount),
  outlookController.disconnectOutlookAccount
);

router.get('/messages', requirePermissions('emails.read'), validate(outlookValidation.listMessages), outlookController.listMessages);
router.get('/threads', requirePermissions('emails.read'), validate(outlookValidation.listThreads), outlookController.listThreads);
router.get('/threads/:id', requirePermissions('emails.read'), validate(outlookValidation.getThread), outlookController.getThread);
router.post(
  '/messages/batch-modify',
  requirePermissions('emails.manage'),
  validate(outlookValidation.batchModifyMessages),
  outlookController.batchModifyMessages
);
router.post(
  '/threads/batch-modify',
  requirePermissions('emails.manage'),
  validate(outlookValidation.batchModifyThreads),
  outlookController.batchModifyThreads
);
router.post('/threads/trash', requirePermissions('emails.manage'), validate(outlookValidation.trashThreads), outlookController.trashThreads);
router.get('/messages/:id', requirePermissions('emails.read'), validate(outlookValidation.getMessage), outlookController.getMessage);
router.get(
  '/messages/:messageId/attachments/:attachmentId',
  requirePermissions('emails.read'),
  validate(outlookValidation.getAttachment),
  outlookController.getAttachment
);
router.post('/messages/send', requirePermissions('emails.manage'), validate(outlookValidation.sendMessage), outlookController.sendMessage);
router.post(
  '/messages/:id/reply-all',
  requirePermissions('emails.manage'),
  validate(outlookValidation.replyAllMessage),
  outlookController.replyAllMessage
);
router.post('/messages/:id/reply', requirePermissions('emails.manage'), validate(outlookValidation.replyMessage), outlookController.replyMessage);
router.post('/messages/:id/forward', requirePermissions('emails.manage'), validate(outlookValidation.forwardMessage), outlookController.forwardMessage);
router.patch('/messages/:id', requirePermissions('emails.manage'), validate(outlookValidation.modifyMessage), outlookController.modifyMessage);
router.delete('/messages/:id', requirePermissions('emails.manage'), validate(outlookValidation.deleteMessage), outlookController.deleteMessage);

router.get('/labels', requirePermissions('emails.read'), validate(outlookValidation.listLabels), outlookController.listLabels);
router.post('/labels', requirePermissions('emails.manage'), validate(outlookValidation.createLabel), outlookController.createLabel);

export default router;
