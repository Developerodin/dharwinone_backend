import express from 'express';
import httpStatus from 'http-status';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import ApiError from '../../utils/ApiError.js';
import { getGrantingPermissions } from '../../config/permissions.js';
import { userIsAdmin } from '../../utils/roleHelpers.js';
import * as bolnaValidation from '../../validations/bolna.validation.js';
import * as bolnaController from '../../controllers/bolna.controller.js';
import * as bolnaCandidateAgentSettingsController from '../../controllers/bolnaCandidateAgentSettings.controller.js';

const router = express.Router();

/** users.manage (derived from settings.users) or Administrator role */
const requireUsersManageOrAdministrator = async (req, res, next) => {
  const granting = getGrantingPermissions('users.manage');
  const has = granting.some((p) => req.authContext.permissions.has(p));
  if (has) return next();
  try {
    if (await userIsAdmin(req.user)) return next();
  } catch {
    /* fall through */
  }
  next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
};

router
  .route('/candidate-agent-settings')
  .get(auth(), requireUsersManageOrAdministrator, bolnaCandidateAgentSettingsController.getBolnaCandidateAgentSettings)
  .patch(
    auth(),
    requireUsersManageOrAdministrator,
    validate(bolnaValidation.patchBolnaCandidateAgentSettings),
    bolnaCandidateAgentSettingsController.patchBolnaCandidateAgentSettings
  );

router
  .route('/call')
  .post(auth(), requirePermissions('calls.manage'), validate(bolnaValidation.initiateCall), bolnaController.initiateCall);

router
  .route('/candidate-call')
  .post(auth(), requirePermissions('calls.manage'), validate(bolnaValidation.initiateCandidateCall), bolnaController.initiateCandidateCall);

router
  .route('/call-status/:executionId')
  .get(auth(), requirePermissions('calls.read'), validate(bolnaValidation.getCallStatus), bolnaController.getCallStatus);

router
  .route('/call-records')
  .get(auth(), requirePermissions('calls.read'), validate(bolnaValidation.getCallRecords), bolnaController.getCallRecords);

router
  .route('/call-records/sync')
  .post(auth(), requirePermissions('calls.manage'), bolnaController.syncMissingCallRecords);

router
  .route('/call-records/:id')
  .delete(auth(), requirePermissions('calls.manage'), validate(bolnaValidation.deleteCallRecord), bolnaController.deleteCallRecord);

export default router;

