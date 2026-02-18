import express from 'express';
import validate from '../../middlewares/validate.js';
import * as authValidation from '../../validations/auth.validation.js';
import * as authController from '../../controllers/auth.controller.js';

const router = express.Router();

/**
 * POST /v1/public/register
 * Public registration (no auth). Creates user with status 'pending'.
 * User cannot login or access the system until an administrator sets status to 'active'.
 * No tokens or cookies are issued.
 */
router.post('/register', validate(authValidation.register), authController.publicRegister);

/**
 * POST /v1/public/register-candidate
 * Public candidate onboarding (no auth). Creates user with status 'pending' and a Candidate
 * linked to that user so they appear in the ATS candidate list.
 */
router.post('/register-candidate', validate(authValidation.registerCandidate), authController.publicRegisterCandidate);

export default router;
