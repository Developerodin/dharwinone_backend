import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { requirePermissionOrAdministrator } from '../../middlewares/requirePermissionOrAdministrator.js';
import * as plivoValidation from '../../validations/plivo.validation.js';
import * as plivoController from '../../controllers/plivo.controller.js';

const router = express.Router();

router
  .route('/numbers/available')
  .get(
    auth(),
    requirePermissionOrAdministrator('calls.read'),
    validate(plivoValidation.searchAvailableNumbers),
    plivoController.getAvailableNumbers
  );

// Buying a number is a real, paid action — gate behind calls.manage.
router
  .route('/numbers/buy')
  .post(
    auth(),
    requirePermissionOrAdministrator('calls.manage'),
    validate(plivoValidation.buyNumber),
    plivoController.buyNumber
  );

export default router;
