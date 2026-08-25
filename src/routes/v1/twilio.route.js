import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { requirePermissionOrAdministrator } from '../../middlewares/requirePermissionOrAdministrator.js';
import requireTelephonyProvider from '../../middlewares/requireTelephonyProvider.js';
import * as plivoValidation from '../../validations/plivo.validation.js';
import * as plivoController from '../../controllers/plivo.controller.js';

const router = express.Router();

// Buying a number is a real, paid action — gate behind calls.create.
router
  .route('/numbers/buy')
  .post(
    auth(),
    requirePermissionOrAdministrator('calls.create'),
    requireTelephonyProvider('twilio'),
    validate(plivoValidation.buyNumber),
    plivoController.buyNumber
  );

export default router;
