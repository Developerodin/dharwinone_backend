import express from 'express';
import httpStatus from 'http-status';
import ApiError from '../../utils/ApiError.js';
import multer from 'multer';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as authValidation from '../../validations/auth.validation.js';
import * as authController from '../../controllers/auth.controller.js';
import auth from '../../middlewares/auth.js';
import optionalAuth from '../../middlewares/optionalAuth.js';
import requirePermissionIfAuthenticated from '../../middlewares/requirePermissionIfAuthenticated.js';
import requireAdministratorRole from '../../middlewares/requireAdministratorRole.js';
import requireAdministratorOrPermission from '../../middlewares/requireAdministratorOrPermission.js';
import { authLoginLimiter, authStrictFlowLimiter, documentScanLimiter } from '../../middlewares/rateLimiter.js';
import { uploadPublicCandidateRegistration } from '../../middlewares/upload.js';
import { verifyCaptchaUnlessAuthenticated } from '../../middlewares/verifyCaptcha.js';

const router = express.Router();

const RESUME_ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const RESUME_MAX_BYTES = 15 * 1024 * 1024;

const resumeSkillsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RESUME_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (RESUME_ALLOWED_MIMES.has(file.mimetype) || ext.endsWith('.pdf') || ext.endsWith('.docx')) {
      cb(null, true);
      return;
    }
    // ApiError, not a bare Error: errorConverter gives anything without a status a 500,
    // so picking the wrong file type answered "Internal Server Error".
    cb(new ApiError(httpStatus.BAD_REQUEST, 'Upload a PDF or DOCX resume.'), false);
  },
});

/** Maps multer's own MulterError, which carries no HTTP status, onto a 400. */
const uploadResumeForSkills = (req, res, next) => {
  resumeSkillsUpload.single('file')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(new ApiError(httpStatus.BAD_REQUEST, 'That file is too large. Maximum 15MB.'));
      return;
    }
    next(err);
  });
};

const SCAN_ALLOWED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']);
const SCAN_MAX_BYTES = 8 * 1024 * 1024;

const documentScanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCAN_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    const okExt = ['.jpg', '.jpeg', '.png', '.pdf'].some((e) => ext.endsWith(e));
    if (SCAN_ALLOWED_MIMES.has(file.mimetype) || okExt) {
      cb(null, true);
      return;
    }
    // ApiError, not a bare Error: errorConverter gives anything without a status a 500,
    // which turned "wrong file type" into "Internal Server Error". Named formats too —
    // a .heic straight off a Mac is the likely reject and the user needs to know what
    // to convert it to.
    cb(new ApiError(httpStatus.BAD_REQUEST, 'Upload the document as a JPG, PNG or PDF.'), false);
  },
});

/**
 * Multer reports its own limits by throwing MulterError, which carries no HTTP status,
 * so an oversized upload answered 500 until this mapped it. Shared by both scan routes.
 */
const uploadScannedDocument = (req, res, next) => {
  documentScanUpload.single('file')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(new ApiError(httpStatus.BAD_REQUEST, 'That file is too large. Maximum 8MB.'));
      return;
    }
    next(err);
  });
};

router.post(
  '/register',
  authStrictFlowLimiter,
  optionalAuth(),
  verifyCaptchaUnlessAuthenticated,
  uploadPublicCandidateRegistration,
  validate(authValidation.register),
  authController.register
);
router.post(
  '/register-student',
  authStrictFlowLimiter,
  optionalAuth(),
  requirePermissionIfAuthenticated('students.manage'),
  validate(authValidation.registerStudent),
  authController.registerStudent
);
router.post(
  '/register-mentor',
  authStrictFlowLimiter,
  optionalAuth(),
  validate(authValidation.registerMentor),
  authController.registerMentor
);
router.post('/register-recruiter', auth(), requireAdministratorRole(), validate(authValidation.registerRecruiter), authController.registerRecruiter);
router.post('/login', authLoginLimiter, validate(authValidation.login), authController.login);
router.post('/logout', validate(authValidation.logout), authController.logout);
router.post('/refresh-tokens', validate(authValidation.refreshTokens), authController.refreshTokens);
router.get('/me', auth(), authController.getMe);
router.patch('/me', auth(), validate(authValidation.updateMe), authController.updateMe);
router.get('/me/with-candidate', auth(), authController.getMeWithCandidate);
router.patch('/me/with-candidate', auth(), validate(authValidation.updateMeWithCandidate), authController.updateMeWithCandidate);
router.post(
  '/me/extract-skills-from-resume',
  auth(),
  authStrictFlowLimiter,
  uploadResumeForSkills,
  authController.extractSkillsFromResume
);
router.post(
  '/me/extract-ead-card',
  auth(),
  documentScanLimiter,
  uploadScannedDocument,
  authController.extractEadCard
);
// Same upload rules as the EAD scan — JPG/PNG/PDF, 8MB — so the two share one multer.
router.post(
  '/me/extract-visa',
  auth(),
  documentScanLimiter,
  uploadScannedDocument,
  authController.extractVisa
);
router.post(
  '/me/recommend-skills-by-role',
  auth(),
  authStrictFlowLimiter,
  validate(authValidation.recommendSkillsByRole),
  authController.recommendSkillsByRole
);
router.get('/me/skill-recommendations', auth(), authController.listSkillRecommendations);
router.post('/me/send-verification-email', auth(), authStrictFlowLimiter, authController.sendMyVerificationEmail);
router.get('/my-permissions', auth(), authController.getMyPermissions);
router.get('/page-capabilities', auth(), authController.getMyPageCapabilities);
router.post('/impersonate', auth(), requireAdministratorOrPermission('users.impersonate', ['Administrator']), validate(authValidation.impersonate), authController.impersonate);
router.post('/stop-impersonation', auth(), authController.stopImpersonation);
router.post('/forgot-password', authStrictFlowLimiter, validate(authValidation.forgotPassword), authController.forgotPassword);
router.post('/reset-password', authStrictFlowLimiter, validate(authValidation.resetPassword), authController.resetPassword);
router.post('/change-password', auth(), validate(authValidation.changePassword), authController.changePassword);
router.post('/send-verification-email', auth(), requirePermissions('users.manage'), authController.sendVerificationEmail);
router.post('/verify-email', authStrictFlowLimiter, validate(authValidation.verifyEmail), authController.verifyEmail);
router.post('/send-candidate-invitation', auth(), requirePermissions('share-candidate-form.read'), validate(authValidation.sendCandidateInvitation), authController.sendCandidateInvitation);

export default router;


/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register as user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *                 description: must be unique
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 description: At least one number and one letter
 *             example:
 *               name: fake name
 *               email: fake@example.com
 *               password: password1
 *     responses:
 *       "201":
 *         description: Created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 tokens:
 *                   $ref: '#/components/schemas/AuthTokens'
 *       "400":
 *         $ref: '#/components/responses/DuplicateEmail'
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *               platform:
 *                 type: string
 *                 description: Optional client platform. Use "app" for mobile; blocked only when all active roles are Candidate/Student/Mentor.
 *             example:
 *               email: fake@example.com
 *               password: password1
 *               platform: app
 *     responses:
 *       "200":
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 tokens:
 *                   $ref: '#/components/schemas/AuthTokens'
 *       "401":
 *         description: Invalid email or password
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: Invalid email or password
 *       "403":
 *         description: Role not allowed on mobile app (when platform is app)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 403
 *               message: This role is not allowed to access the mobile app.
 *               errorCode: MOBILE_APP_ROLE_NOT_ALLOWED
 */

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *             example:
 *               refreshToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1ZWJhYzUzNDk1NGI1NDEzOTgwNmMxMTIiLCJpYXQiOjE1ODkyOTg0ODQsImV4cCI6MTU4OTMwMDI4NH0.m1U63blB0MLej_WfB7yC2FTMnCziif9X8yzwDEfJXAg
 *     responses:
 *       "204":
 *         description: No content
 *       "404":
 *         $ref: '#/components/responses/NotFound'
 */

/**
 * @swagger
 * /auth/refresh-tokens:
 *   post:
 *     summary: Refresh auth tokens
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *             example:
 *               refreshToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1ZWJhYzUzNDk1NGI1NDEzOTgwNmMxMTIiLCJpYXQiOjE1ODkyOTg0ODQsImV4cCI6MTU4OTMwMDI4NH0.m1U63blB0MLej_WfB7yC2FTMnCziif9X8yzwDEfJXAg
 *     responses:
 *       "200":
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthTokens'
 *       "401":
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Forgot password
 *     description: An email will be sent to reset password.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *             example:
 *               email: fake@example.com
 *     responses:
 *       "204":
 *         description: No content
 *       "404":
 *         $ref: '#/components/responses/NotFound'
 */

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Reset password
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The reset password token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 description: At least one number and one letter
 *             example:
 *               password: password1
 *     responses:
 *       "204":
 *         description: No content
 *       "401":
 *         description: Password reset failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: Password reset failed
 */

/**
 * @swagger
 * /auth/send-verification-email:
 *   post:
 *     summary: Send verification email
 *     description: An email will be sent to verify email.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       "204":
 *         description: No content
 *       "401":
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /auth/verify-email:
 *   post:
 *     summary: verify email
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The verify email token
 *     responses:
 *       "204":
 *         description: No content
 *       "401":
 *         description: verify email failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: verify email failed
 */
