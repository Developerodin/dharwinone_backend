import express from 'express';
import multer from 'multer';
import config from '../../config/config.js';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  requireAnyOfPermissionsOrAdministrator,
  requirePermissionOrAdministrator,
} from '../../middlewares/requirePermissionOrAdministrator.js';
import * as voiceAgentValidation from '../../validations/voiceAgent.validation.js';
import * as voiceKbController from '../../controllers/voiceKb.controller.js';

const maxPdfBytes = (config.voiceAgentKb.maxPdfMb || 25) * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxPdfBytes, files: 1 },
});

const router = express.Router();

router.post(
  '/query',
  auth(),
  requireAnyOfPermissionsOrAdministrator('agents.read', 'agents.manage'),
  validate(voiceAgentValidation.kbQuery),
  voiceKbController.postKbQuery
);

router.post(
  '/:agentId/documents/pdf',
  auth(),
  requirePermissionOrAdministrator('agents.manage'),
  validate(voiceAgentValidation.kbPdfIngest),
  upload.single('file'),
  voiceKbController.postPdfDocument
);

router.post(
  '/:agentId/documents/text',
  auth(),
  requirePermissionOrAdministrator('agents.manage'),
  validate(voiceAgentValidation.kbTextIngest),
  voiceKbController.postTextDocument
);

router.post(
  '/:agentId/documents/url',
  auth(),
  requirePermissionOrAdministrator('agents.manage'),
  validate(voiceAgentValidation.kbUrlIngest),
  voiceKbController.postUrlDocument
);

router.get(
  '/:agentId/documents',
  auth(),
  requireAnyOfPermissionsOrAdministrator('agents.read', 'agents.manage'),
  validate(voiceAgentValidation.kbListDocs),
  voiceKbController.listDocuments
);

router.delete(
  '/documents/:documentId',
  auth(),
  requirePermissionOrAdministrator('agents.manage'),
  validate(voiceAgentValidation.kbDeleteDoc),
  voiceKbController.deleteDocument
);

export default router;
