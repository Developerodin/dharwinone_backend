import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as featureFlagValidation from '../../validations/featureFlag.validation.js';
import * as featureFlagController from '../../controllers/featureFlag.controller.js';

const router = express.Router();

router
  .route('/:key')
  .get(auth(), validate(featureFlagValidation.getFeatureFlag), featureFlagController.get);

export default router;
