import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as offerValidation from '../../validations/offer.validation.js';
import * as offerController from '../../controllers/offer.controller.js';

const router = express.Router();

router.get(
  '/letter-defaults',
  auth(),
  requirePermissions('candidates.read'),
  validate(offerValidation.letterDefaults),
  offerController.letterDefaults
);

router.post(
  '/enhance-roles',
  auth(),
  requirePermissions('candidates.manage'),
  validate(offerValidation.enhanceRoles),
  offerController.enhanceRoles
);

router.post(
  '/:offerId/generate-letter',
  auth(),
  requirePermissions('candidates.manage'),
  validate(offerValidation.generateLetter),
  offerController.generateLetter
);

router
  .route('/')
  .post(
    auth(),
    requirePermissions('candidates.manage'),
    validate(offerValidation.createOffer),
    offerController.create
  )
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(offerValidation.getOffers),
    offerController.list
  );

router
  .route('/:offerId')
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(offerValidation.getOffer),
    offerController.get
  )
  .patch(
    auth(),
    requirePermissions('candidates.manage'),
    validate(offerValidation.updateOffer),
    offerController.update
  )
  .delete(
    auth(),
    requirePermissions('candidates.manage'),
    validate(offerValidation.deleteOffer),
    offerController.remove
  );

export default router;
