import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as candidateSopTemplateValidation from '../../validations/candidateSopTemplate.validation.js';
import candidateSopTemplateController from '../../controllers/candidateSopTemplate.controller.js';

const router = express.Router();

const canManage = [auth(), requirePermissions('candidates.manage')];

router.route('/active').get(...canManage, candidateSopTemplateController.getActive);

router
  .route('/')
  .get(...canManage, candidateSopTemplateController.list)
  .post(...canManage, validate(candidateSopTemplateValidation.createCandidateSopTemplate), candidateSopTemplateController.create);

router
  .route('/:templateId')
  .get(...canManage, validate(candidateSopTemplateValidation.candidateSopTemplateId), candidateSopTemplateController.getOne)
  .patch(
    ...canManage,
    validate(candidateSopTemplateValidation.updateCandidateSopTemplate),
    candidateSopTemplateController.update
  )
  .delete(...canManage, validate(candidateSopTemplateValidation.candidateSopTemplateId), candidateSopTemplateController.remove);

router.post(
  '/:templateId/set-active',
  ...canManage,
  validate(candidateSopTemplateValidation.candidateSopTemplateId),
  candidateSopTemplateController.setActive
);

export default router;
