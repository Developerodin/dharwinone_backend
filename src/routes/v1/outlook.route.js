import express from 'express';
import config from '../../config/config.js';
import auth from '../../middlewares/auth.js';
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

router.get('/accounts', validate(outlookValidation.listOutlookAccounts), outlookController.listOutlookAccounts);
router.get('/auth/microsoft', validate(outlookValidation.getMicrosoftAuthUrl), outlookController.getMicrosoftAuthUrl);
router.delete(
  '/accounts/:id',
  validate(outlookValidation.disconnectOutlookAccount),
  outlookController.disconnectOutlookAccount
);

router.get('/messages', validate(outlookValidation.listMessages), outlookController.listMessages);
router.get('/threads', validate(outlookValidation.listThreads), outlookController.listThreads);
router.get('/threads/:id', validate(outlookValidation.getThread), outlookController.getThread);
router.post(
  '/messages/batch-modify',
  validate(outlookValidation.batchModifyMessages),
  outlookController.batchModifyMessages
);
router.post(
  '/threads/batch-modify',
  validate(outlookValidation.batchModifyThreads),
  outlookController.batchModifyThreads
);
router.post('/threads/trash', validate(outlookValidation.trashThreads), outlookController.trashThreads);
router.get('/messages/:id', validate(outlookValidation.getMessage), outlookController.getMessage);
router.get(
  '/messages/:messageId/attachments/:attachmentId',
  validate(outlookValidation.getAttachment),
  outlookController.getAttachment
);
router.post('/messages/send', validate(outlookValidation.sendMessage), outlookController.sendMessage);
router.post('/messages/:id/reply', validate(outlookValidation.replyMessage), outlookController.replyMessage);
router.post('/messages/:id/forward', validate(outlookValidation.forwardMessage), outlookController.forwardMessage);
router.patch('/messages/:id', validate(outlookValidation.modifyMessage), outlookController.modifyMessage);
router.delete('/messages/:id', validate(outlookValidation.deleteMessage), outlookController.deleteMessage);

router.get('/labels', validate(outlookValidation.listLabels), outlookController.listLabels);
router.post('/labels', validate(outlookValidation.createLabel), outlookController.createLabel);

export default router;
