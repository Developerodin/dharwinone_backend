import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import rubricTemplateValidation from '../../validations/rubricTemplate.validation.js';
import rubricTemplateController from '../../controllers/rubricTemplate.controller.js';

const router = express.Router();

// `/resolve` MUST be declared before `/:templateId`, or "resolve" is captured as an id.
router
  .route('/resolve')
  .get(
    auth(),
    requirePermissions('interviews.read'),
    validate(rubricTemplateValidation.resolveRubric),
    rubricTemplateController.resolve
  );

router
  .route('/')
  .get(
    auth(),
    requirePermissions('interviews.read'),
    validate(rubricTemplateValidation.getRubricTemplates),
    rubricTemplateController.list
  )
  .post(
    auth(),
    requirePermissions('interviews.manage'),
    validate(rubricTemplateValidation.createRubricTemplate),
    rubricTemplateController.create
  );

router
  .route('/:templateId/archive')
  .post(
    auth(),
    requirePermissions('interviews.manage'),
    validate(rubricTemplateValidation.getRubricTemplate),
    rubricTemplateController.archive
  );

router
  .route('/:templateId/restore')
  .post(
    auth(),
    requirePermissions('interviews.manage'),
    validate(rubricTemplateValidation.getRubricTemplate),
    rubricTemplateController.restore
  );

router
  .route('/:templateId')
  .get(
    auth(),
    requirePermissions('interviews.read'),
    validate(rubricTemplateValidation.getRubricTemplate),
    rubricTemplateController.get
  )
  .patch(
    auth(),
    requirePermissions('interviews.manage'),
    validate(rubricTemplateValidation.updateRubricTemplate),
    rubricTemplateController.update
  );

export default router;
