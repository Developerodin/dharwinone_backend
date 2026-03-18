import express from 'express';
import config from '../../config/config.js';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as emailValidation from '../../validations/email.validation.js';
import * as outlookValidation from '../../validations/outlook.validation.js';
import * as emailController from '../../controllers/email.controller.js';
import * as outlookController from '../../controllers/outlook.controller.js';
import logger from '../../config/logger.js';

const router = express.Router();

// Google OAuth callback - no auth (redirect from Google)
// If opened without code/state (e.g. direct visit), redirect to frontend instead of 400
router.get('/auth/google/callback', (req, res, next) => {
  logger.info('[Gmail] Callback received query: %o', req.query);
  if (!req.query?.code || !req.query?.state) {
    if (req.query?.error) {
      logger.error('[Gmail] Google returned error: %s (%s)', req.query.error, req.query.error_description || 'no description');
    }
    return res.redirect(`${config.frontendBaseUrl}/communication/email?error=missing_callback_params`);
  }
  next();
}, validate(emailValidation.googleCallback), emailController.googleCallback);

/** @deprecated Prefer `/v1/outlook/auth/microsoft/callback` in Azure; same OAuth handler. */
function outlookMicrosoftCallbackGuard(req, res, next) {
  logger.info('[Outlook-Legacy] Callback received query: %o', req.query);
  if (!req.query?.code || !req.query?.state) {
    if (req.query?.error) {
       logger.error('[Outlook-Legacy] Microsoft returned error: %s (%s)', req.query.error, req.query.error_description || 'no description');
    }
    return res.redirect(`${config.frontendBaseUrl}/communication/email?error=missing_callback_params`);
  }
  next();
}
router.get(
  ['/auth/microsoft/callback', '/auth/microsoft/callback/'],
  outlookMicrosoftCallbackGuard,
  validate(outlookValidation.microsoftCallback),
  outlookController.microsoftCallback
);

router.use(auth());

router.get('/accounts', validate(emailValidation.listGmailAccounts), emailController.listGmailAccounts);
router.get('/auth/google', validate(emailValidation.getGoogleAuthUrl), emailController.getGoogleAuthUrl);
router.delete('/accounts/:id', validate(emailValidation.disconnectAccount), emailController.disconnectGmailAccount);

router.get('/messages', validate(emailValidation.listMessages), emailController.listMessages);
router.get('/threads', validate(emailValidation.listThreads), emailController.listThreads);
router.get('/threads/:id', validate(emailValidation.getThread), emailController.getThread);
router.post(
  '/messages/batch-modify',
  validate(emailValidation.batchModifyMessages),
  emailController.batchModifyMessages
);
router.post(
  '/threads/batch-modify',
  validate(emailValidation.batchModifyThreads),
  emailController.batchModifyThreads
);
router.post(
  '/threads/trash',
  validate(emailValidation.trashThreads),
  emailController.trashThreads
);
router.get('/messages/:id', validate(emailValidation.getMessage), emailController.getMessage);
router.get(
  '/messages/:messageId/attachments/:attachmentId',
  validate(emailValidation.getAttachment),
  emailController.getAttachment
);
router.post('/messages/send', validate(emailValidation.sendMessage), emailController.sendMessage);
router.post('/messages/:id/reply', validate(emailValidation.replyMessage), emailController.replyMessage);
router.post('/messages/:id/forward', validate(emailValidation.forwardMessage), emailController.forwardMessage);
router.patch('/messages/:id', validate(emailValidation.modifyMessage), emailController.modifyMessage);
router.delete('/messages/:id', validate(emailValidation.deleteMessage), emailController.deleteMessage);

router.get('/labels', validate(emailValidation.listLabels), emailController.listLabels);
router.post('/labels', validate(emailValidation.createLabel), emailController.createLabel);

export default router;
