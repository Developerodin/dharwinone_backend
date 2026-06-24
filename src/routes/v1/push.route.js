import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as pushValidation from '../../validations/push.validation.js';
import * as pushController from '../../controllers/push.controller.js';

const router = express.Router();

// Auth only — operations are scoped to req.user; no extra permission gate needed
// (any authenticated user may register their own device for push).
router.use(auth());

router.post('/register-token', validate(pushValidation.registerToken), pushController.registerToken);
router.post('/unregister-token', validate(pushValidation.unregisterToken), pushController.unregisterToken);

export default router;
