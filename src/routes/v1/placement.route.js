import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as placementValidation from '../../validations/placement.validation.js';
import * as placementController from '../../controllers/placement.controller.js';

const router = express.Router();

router
  .route('/')
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(placementValidation.getPlacements),
    placementController.list
  );

router
  .route('/:placementId')
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(placementValidation.getPlacement),
    placementController.get
  )
  .patch(
    auth(),
    requirePermissions('candidates.manage'),
    validate(placementValidation.updatePlacement),
    placementController.update
  );

export default router;
