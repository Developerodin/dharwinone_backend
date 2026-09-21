import express from 'express';
import auth from '../../middlewares/auth.js';
import { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as payrollValidation from '../../validations/payrollDetail.validation.js';
import * as payrollController from '../../controllers/payrollDetail.controller.js';

const router = express.Router();

const canRead = [
  auth(),
  requireAnyOfPermissions('payroll-details.read', 'candidates.manage', 'pre-boarding.read'),
];
const canRequest = [
  auth(),
  requireAnyOfPermissions('payroll-details.create', 'candidates.manage', 'pre-boarding.create'),
];
const canWrite = [
  auth(),
  requireAnyOfPermissions('payroll-details.edit', 'candidates.manage', 'pre-boarding.edit'),
];
/**
 * Deliberately narrower than every other gate here: decrypting a full account number
 * is not the same act as seeing that one exists. pre-boarding roles do NOT get this.
 */
const canReveal = [auth(), requireAnyOfPermissions('payroll-details.manage', 'candidates.manage')];

// Self-service first — Express would otherwise match "me" as :employeeId and the
// objectId validator would 400.
router
  .route('/me')
  .get(auth(), payrollController.getMyDetails)
  .post(auth(), validate(payrollValidation.submitMyDetails), payrollController.submitMyDetails);

router
  .route('/:employeeId')
  .get(...canRead, validate(payrollValidation.getDetails), payrollController.getDetails)
  .post(...canWrite, validate(payrollValidation.submitDetails), payrollController.submitOnBehalf);

// Cancel sits on the same gate as request: whoever may ask may un-ask. It only ever
// removes a 'requested' record with nothing submitted — the service refuses otherwise,
// so this does not need the narrower write gate.
router
  .route('/:employeeId/request')
  .post(...canRequest, validate(payrollValidation.requestDetails), payrollController.requestDetails)
  .delete(...canRequest, validate(payrollValidation.cancelRequest), payrollController.cancelRequest);

router
  .route('/:employeeId/verify')
  .patch(...canWrite, validate(payrollValidation.verifyDetails), payrollController.verifyDetails);

router
  .route('/:employeeId/reveal')
  .post(...canReveal, validate(payrollValidation.revealAccount), payrollController.revealAccount);

export default router;
