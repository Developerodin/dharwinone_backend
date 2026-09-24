import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import requireAdministratorOrPermission from '../../middlewares/requireAdministratorOrPermission.js';
import * as v from '../../validations/interviewScheduling.validation.js';
import * as c from '../../controllers/interviewScheduling.controller.js';

const router = express.Router();

// Own hours: Settings → Interview Availability matrix row (Administrators bypass).
const canViewOwnAvailability = requireAdministratorOrPermission('interview-availability.read', ['Administrator']);
const canSaveOwnAvailability = requireAdministratorOrPermission('interview-availability.manage', ['Administrator']);
const adminOrManage = requireAdministratorOrPermission('interviews.manage', ['Administrator']);

// Own availability. MUST be before /availability/:userId so "me" is not read as an id.
router
  .route('/availability/me')
  .get(auth(), canViewOwnAvailability, c.getMyAvailability)
  .put(auth(), canSaveOwnAvailability, validate(v.putMyAvailability), c.putMyAvailability);

router
  .route('/availability/:userId')
  .get(auth(), adminOrManage, validate(v.getUserAvailability), c.getUserAvailability)
  .put(auth(), adminOrManage, validate(v.putUserAvailability), c.putUserAvailability);

router.get('/holds', auth(), requirePermissions('interviews.manage'), validate(v.listHolds), c.listHolds);
router.post('/holds/:id/approve', auth(), requirePermissions('interviews.manage'), validate(v.approveHold), c.approveHold);
router.post('/holds/:id/reject', auth(), requirePermissions('interviews.manage'), validate(v.rejectHold), c.rejectHold);

router.get('/slots/preview', auth(), requirePermissions('interviews.manage'), validate(v.previewSlots), c.previewSlots);

export default router;
