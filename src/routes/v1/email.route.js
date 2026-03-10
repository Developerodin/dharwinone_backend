import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as emailValidation from '../../validations/email.validation.js';
import * as emailController from '../../controllers/email.controller.js';

const router = express.Router();

// Google OAuth callback - no auth (redirect from Google)
router.get('/auth/google/callback', validate(emailValidation.googleCallback), emailController.googleCallback);

router.use(auth());

router.get('/accounts', validate(emailValidation.listAccounts), emailController.listAccounts);
router.get('/auth/google', validate(emailValidation.getGoogleAuthUrl), emailController.getGoogleAuthUrl);
router.delete('/accounts/:id', validate(emailValidation.disconnectAccount), emailController.disconnectAccount);

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
