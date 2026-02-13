import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as certificateValidation from '../../validations/certificate.validation.js';
import * as certificateController from '../../controllers/certificate.controller.js';

const router = express.Router();

// Public certificate verification endpoint (no auth required)
router
  .route('/verify/:verificationCode')
  .get(
    validate(certificateValidation.verifyCertificate),
    certificateController.verifyCertificate
  );

export default router;
