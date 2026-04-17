import express from 'express';
import config from '../../config/config.js';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as emailValidation from '../../validations/email.validation.js';
import * as outlookValidation from '../../validations/outlook.validation.js';
import * as emailController from '../../controllers/email.controller.js';
import * as emailPreferencesController from '../../controllers/emailPreferences.controller.js';
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

router.get(
  '/connection-policy',
  requireAnyOfPermissions('emails.read', 'emails.manage'),
  validate(emailValidation.connectionPolicy),
  emailController.getConnectionPolicy
);
router.get('/accounts', requirePermissions('emails.read'), validate(emailValidation.listGmailAccounts), emailController.listGmailAccounts);
router.get('/auth/google', requirePermissions('emails.manage'), validate(emailValidation.getGoogleAuthUrl), emailController.getGoogleAuthUrl);
router.delete(
  '/accounts/:id',
  requirePermissions('emails.manage'),
  validate(emailValidation.disconnectAccount),
  emailController.disconnectGmailAccount
);

router.get('/messages', requirePermissions('emails.read'), validate(emailValidation.listMessages), emailController.listMessages);
router.get('/threads', requirePermissions('emails.read'), validate(emailValidation.listThreads), emailController.listThreads);
router.get('/threads/:id', requirePermissions('emails.read'), validate(emailValidation.getThread), emailController.getThread);
router.post(
  '/messages/batch-modify',
  requirePermissions('emails.manage'),
  validate(emailValidation.batchModifyMessages),
  emailController.batchModifyMessages
);
router.post(
  '/threads/batch-modify',
  requirePermissions('emails.manage'),
  validate(emailValidation.batchModifyThreads),
  emailController.batchModifyThreads
);
router.post(
  '/threads/trash',
  requirePermissions('emails.manage'),
  validate(emailValidation.trashThreads),
  emailController.trashThreads
);
router.get('/messages/:id', requirePermissions('emails.read'), validate(emailValidation.getMessage), emailController.getMessage);
router.get(
  '/messages/:messageId/attachments/:attachmentId',
  requirePermissions('emails.read'),
  validate(emailValidation.getAttachment),
  emailController.getAttachment
);
router.post('/drafts/generate', requirePermissions('emails.manage'), validate(emailValidation.generateDraft), emailController.generateDraft);
router.post('/messages/send', requirePermissions('emails.manage'), validate(emailValidation.sendMessage), emailController.sendMessage);
router.post(
  '/messages/:id/reply-all',
  requirePermissions('emails.manage'),
  validate(emailValidation.replyAllMessage),
  emailController.replyAllMessage
);
router.post('/messages/:id/reply', requirePermissions('emails.manage'), validate(emailValidation.replyMessage), emailController.replyMessage);
router.post('/messages/:id/forward', requirePermissions('emails.manage'), validate(emailValidation.forwardMessage), emailController.forwardMessage);
router.patch('/messages/:id', requirePermissions('emails.manage'), validate(emailValidation.modifyMessage), emailController.modifyMessage);
router.delete('/messages/:id', requirePermissions('emails.manage'), validate(emailValidation.deleteMessage), emailController.deleteMessage);

router.get('/labels', requirePermissions('emails.read'), validate(emailValidation.listLabels), emailController.listLabels);
router.post('/labels', requirePermissions('emails.manage'), validate(emailValidation.createLabel), emailController.createLabel);

// Personal email templates & signature (Gmail + Outlook compose use same prefs)
router.get(
  '/templates',
  requirePermissions('emails.read'),
  validate(emailValidation.listEmailTemplates),
  emailPreferencesController.listTemplates
);
router.post(
  '/templates',
  requirePermissions('emails.manage'),
  validate(emailValidation.createEmailTemplate),
  emailPreferencesController.createTemplate
);
router.patch(
  '/templates/:templateId',
  requirePermissions('emails.manage'),
  validate(emailValidation.updateEmailTemplate),
  emailPreferencesController.updateTemplate
);
router.delete(
  '/templates/:templateId',
  requirePermissions('emails.manage'),
  validate(emailValidation.deleteEmailTemplate),
  emailPreferencesController.deleteTemplate
);
router.get(
  '/signature',
  requirePermissions('emails.read'),
  validate(emailValidation.getEmailSignature),
  emailPreferencesController.getSignature
);
router.patch(
  '/signature',
  requirePermissions('emails.manage'),
  validate(emailValidation.patchEmailSignature),
  emailPreferencesController.patchSignature
);

router.get(
  '/admin/templates',
  requirePermissions('users.manage'),
  validate(emailValidation.adminListEmailTemplates),
  emailPreferencesController.adminListTemplates
);
router.post(
  '/admin/templates',
  requirePermissions('users.manage'),
  validate(emailValidation.adminCreateEmailTemplate),
  emailPreferencesController.adminCreateTemplate
);
router.get(
  '/admin/signature',
  requirePermissions('users.manage'),
  validate(emailValidation.adminGetEmailSignature),
  emailPreferencesController.adminGetSignature
);
router.patch(
  '/admin/templates/:templateId',
  requirePermissions('users.manage'),
  validate(emailValidation.adminUpdateEmailTemplate),
  emailPreferencesController.adminUpdateTemplate
);
router.delete(
  '/admin/templates/:templateId',
  requirePermissions('users.manage'),
  validate(emailValidation.adminDeleteEmailTemplate),
  emailPreferencesController.adminDeleteTemplate
);
router.patch(
  '/admin/signature',
  requirePermissions('users.manage'),
  validate(emailValidation.adminPatchEmailSignature),
  emailPreferencesController.adminPatchSignature
);

export default router;
