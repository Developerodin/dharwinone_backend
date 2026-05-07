import express from 'express';
import Joi from 'joi';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { chatAssistantLimiter } from '../../middlewares/rateLimiter.js';
import * as chatAssistantValidation from '../../validations/chatAssistant.validation.js';
import * as chatAssistantController from '../../controllers/chatAssistant.controller.js';

const router = express.Router();

const updateSettingsSchema = {
  body: Joi.object().keys({
    isGloballyEnabled: Joi.boolean().required(),
    enabledPages: Joi.array().items(Joi.string().trim()).required(),
  }),
};

router
  .route('/message')
  .post(
    auth(),
    chatAssistantLimiter,
    validate(chatAssistantValidation.sendMessage),
    chatAssistantController.sendMessage
  );

router
  .route('/stream')
  .post(
    auth(),
    chatAssistantLimiter,
    validate(chatAssistantValidation.sendMessage),
    chatAssistantController.streamMessage
  );

router
  .route('/settings')
  .get(auth(), chatAssistantController.getSettings)
  .put(auth(), validate(updateSettingsSchema), chatAssistantController.updateSettings);

// Manually bust the 60-second in-memory context cache for the caller's company.
// Useful after bulk imports, new hires, or project restructures.
router
  .route('/refresh')
  .post(auth(), chatAssistantController.refreshCache);

// Clear this user's persisted conversation (ConversationMemory row) AND bust
// the per-admin context cache. Wired to the chatbot's "Clear conversation"
// button so the next turn starts from a clean slate.
router
  .route('/clear')
  .post(auth(), chatAssistantController.clearConversation);

export default router;
