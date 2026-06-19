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

// Numbers already rented/owned on the connected Plivo account.
router
  .route('/numbers/owned')
  .get(
    auth(),
    requirePermissionOrAdministrator('calls.read'),
    validate(plivoValidation.listOwnedNumbers),
    plivoController.getOwnedNumbers
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

// Placing a call is billable — gate behind calls.manage. The public answer-XML
// endpoint (Plivo's webhook) lives in public.route.js, HMAC-signature gated.
router
  .route('/call')
  .post(
    auth(),
    requirePermissionOrAdministrator('calls.manage'),
    validate(plivoValidation.placeCall),
    plivoController.placeCall
  );

// Browser softphone (WebRTC): mint a short-lived outbound-only access token.
// The public answer webhook (/plivo/sdk-answer) lives in public.route.js.
router
  .route('/sdk-token')
  .post(auth(), requirePermissionOrAdministrator('calls.manage'), plivoController.getSdkToken);

// Register dest+callerId before browser client.call() — sdk-answer consumes it.
router
  .route('/browser-call-intent')
  .post(
    auth(),
    requirePermissionOrAdministrator('calls.manage'),
    validate(plivoValidation.browserCallIntent),
    plivoController.postBrowserCallIntent
  );

export default router;
