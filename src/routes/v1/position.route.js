import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as positionValidation from '../../validations/position.validation.js';
import * as positionController from '../../controllers/position.controller.js';

const router = express.Router();

// All positions (no pagination) - for dropdowns. positions.read alias grants via students.read/candidates.read
router.get(
  '/all',
  auth(),
  requirePermissions('positions.read'),
  positionController.getAllPositions
);

router
  .route('/')
  .post(auth(), requirePermissions('positions.manage'), validate(positionValidation.createPosition), positionController.createPosition)
  .get(auth(), requirePermissions('positions.read'), validate(positionValidation.getPositions), positionController.getPositions);

router
  .route('/:positionId')
  .get(auth(), requirePermissions('positions.read'), validate(positionValidation.getPosition), positionController.getPosition)
  .patch(auth(), requirePermissions('positions.manage'), validate(positionValidation.updatePosition), positionController.updatePosition)
  .delete(auth(), requirePermissions('positions.manage'), validate(positionValidation.deletePosition), positionController.deletePosition);

export default router;
