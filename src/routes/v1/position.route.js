import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as positionValidation from '../../validations/position.validation.js';
import * as positionController from '../../controllers/position.controller.js';

const router = express.Router();

// Positions surface in dropdowns inside pre-boarding/onboarding edit modals.
// Accept pipeline-scope perms so non-admin pipeline users can populate the picker.
const canReadPositions = [
  auth(),
  requireAnyOfPermissions(
    'positions.read',
    'pre-boarding.read', 'pre-boarding.edit', 'pre-boarding.manage',
    'onboarding.read', 'onboarding.edit', 'onboarding.manage',
  ),
];

router.get('/all', ...canReadPositions, positionController.getAllPositions);

router
  .route('/')
  .post(auth(), requirePermissions('positions.manage'), validate(positionValidation.createPosition), positionController.createPosition)
  .get(...canReadPositions, validate(positionValidation.getPositions), positionController.getPositions);

router
  .route('/:positionId')
  .get(...canReadPositions, validate(positionValidation.getPosition), positionController.getPosition)
  .patch(auth(), requirePermissions('positions.manage'), validate(positionValidation.updatePosition), positionController.updatePosition)
  .delete(auth(), requirePermissions('positions.manage'), validate(positionValidation.deletePosition), positionController.deletePosition);

export default router;
