import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as communicationValidation from '../../validations/communication.validation.js';
import * as communicationController from '../../controllers/communication.controller.js';

const router = express.Router();

router
  .route('/calls')
  .get(auth(), requirePermissions('calls.read'), validate(communicationValidation.listUnifiedCalls), communicationController.listUnifiedCalls);

export default router;
