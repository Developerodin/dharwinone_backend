import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requireHrmWebRtcAccess from '../../middlewares/requireHrmWebRtcAccess.js';
import * as hrmWebRtcValidation from '../../validations/hrmWebRtc.validation.js';
import * as hrmWebRtcController from '../../controllers/hrmWebRtc.controller.js';

const router = express.Router();

router.route('/signaling-token').post(
  auth(),
  requireHrmWebRtcAccess,
  validate(hrmWebRtcValidation.getSignalingToken),
  hrmWebRtcController.getSignalingToken
);

router.route('/device-token').post(
  auth(),
  requireHrmWebRtcAccess,
  validate(hrmWebRtcValidation.createDeviceToken),
  hrmWebRtcController.createDeviceToken
);

router.route('/revoke-device-token').post(
  auth(),
  requireHrmWebRtcAccess,
  validate(hrmWebRtcValidation.revokeDeviceToken),
  hrmWebRtcController.revokeDeviceToken
);

router.route('/device-tokens').get(
  auth(),
  requireHrmWebRtcAccess,
  validate(hrmWebRtcValidation.listDeviceTokens),
  hrmWebRtcController.listDeviceTokens
);

export default router;
