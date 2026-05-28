import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as placementValidation from '../../validations/placement.validation.js';
import * as placementController from '../../controllers/placement.controller.js';

const router = express.Router();

// Pre-boarding / Onboarding / Offers list rows are all placement records.
// Accept ANY pipeline-scope perm — read/create/edit/delete/manage — since each implies needing to see the data.
const canReadPlacements = [
  auth(),
  requireAnyOfPermissions(
    'candidates.read',
    'pre-boarding.read', 'pre-boarding.create', 'pre-boarding.edit', 'pre-boarding.delete', 'pre-boarding.manage',
    'onboarding.read', 'onboarding.create', 'onboarding.edit', 'onboarding.delete', 'onboarding.manage',
    'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
  ),
];

router
  .route('/')
  .get(
    ...canReadPlacements,
    validate(placementValidation.getPlacements),
    placementController.list
  );

router
  .route('/:placementId/audit')
  .get(
    auth(),
    requireAnyOfPermissions('placement.audit', 'candidates.manage'),
    validate(placementValidation.getPlacement),
    placementController.audit
  );

router
  .route('/:placementId')
  .get(
    ...canReadPlacements,
    validate(placementValidation.getPlacement),
    placementController.get
  )
  .patch(
    auth(),
    requireAnyOfPermissions(
      'candidates.manage',
      'pre-boarding.edit',
      'onboarding.edit',
      'offers.edit'
    ),
    validate(placementValidation.updatePlacement),
    placementController.update
  );

export default router;
