import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { requirePermissionOrAdministrator } from '../../middlewares/requirePermissionOrAdministrator.js';
import * as numberPricingValidation from '../../validations/numberPricing.validation.js';
import * as numberPricingController from '../../controllers/numberPricing.controller.js';

const router = express.Router();

router
  .route('/')
  .get(
    auth(),
    requirePermissionOrAdministrator('calls.manage'),
    validate(numberPricingValidation.listPricing),
    numberPricingController.list
  )
  .put(
    auth(),
    requirePermissionOrAdministrator('calls.manage'),
    validate(numberPricingValidation.upsertPricing),
    numberPricingController.upsert
  );

router
  .route('/:id')
  .delete(
    auth(),
    requirePermissionOrAdministrator('calls.manage'),
    validate(numberPricingValidation.deletePricing),
    numberPricingController.remove
  );

export default router;
