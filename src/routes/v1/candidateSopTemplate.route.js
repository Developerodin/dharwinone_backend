import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as candidateSopTemplateValidation from '../../validations/candidateSopTemplate.validation.js';
import candidateSopTemplateController from '../../controllers/candidateSopTemplate.controller.js';

const router = express.Router();

const canReadSop = [auth(), requireAnyOfPermissions('candidate-sop.read', 'candidate-sop.manage')];
const canManageSop = [auth(), requirePermissions('candidate-sop.manage')];

router.route('/active').get(...canReadSop, candidateSopTemplateController.getActive);

router
  .route('/')
  .get(...canReadSop, candidateSopTemplateController.list)
  .post(...canManageSop, validate(candidateSopTemplateValidation.createCandidateSopTemplate), candidateSopTemplateController.create);

router
  .route('/:templateId')
  .get(...canReadSop, validate(candidateSopTemplateValidation.candidateSopTemplateId), candidateSopTemplateController.getOne)
  .patch(
    ...canManageSop,
    validate(candidateSopTemplateValidation.updateCandidateSopTemplate),
    candidateSopTemplateController.update
  )
  .delete(...canManageSop, validate(candidateSopTemplateValidation.candidateSopTemplateId), candidateSopTemplateController.remove);

router.post(
  '/:templateId/set-active',
  ...canManageSop,
  validate(candidateSopTemplateValidation.candidateSopTemplateId),
  candidateSopTemplateController.setActive
);

export default router;
