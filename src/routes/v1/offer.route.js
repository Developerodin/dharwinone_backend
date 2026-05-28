import express from 'express';
import auth from '../../middlewares/auth.js';
import { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as offerValidation from '../../validations/offer.validation.js';
import * as offerController from '../../controllers/offer.controller.js';

const router = express.Router();

// Honor ats.offers:* matrix keys (derive offers.read / .create / .edit / .delete / .manage) in addition
// to legacy candidates.* admin scope. View also unlocked for pipeline-adjacent pre-boarding read users.
const canReadOffers = [
  auth(),
  requireAnyOfPermissions(
    'candidates.read', 'employees.read',
    'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
    'pre-boarding.read', 'pre-boarding.edit', 'pre-boarding.manage',
  ),
];

const canCreateOffers = [
  auth(),
  requireAnyOfPermissions('candidates.manage', 'employees.edit', 'offers.create', 'offers.manage'),
];

const canEditOffers = [
  auth(),
  requireAnyOfPermissions('candidates.manage', 'employees.edit', 'offers.edit', 'offers.manage'),
];

const canDeleteOffers = [
  auth(),
  requireAnyOfPermissions('candidates.manage', 'employees.delete', 'offers.delete', 'offers.manage'),
];

router.get('/letter-defaults', ...canReadOffers, validate(offerValidation.letterDefaults), offerController.letterDefaults);

router.post('/enhance-roles', ...canEditOffers, validate(offerValidation.enhanceRoles), offerController.enhanceRoles);

router.post('/:offerId/share', ...canEditOffers, validate(offerValidation.shareOffer), offerController.shareOffer);

router.post('/:offerId/generate-letter', ...canEditOffers, validate(offerValidation.generateLetter), offerController.generateLetter);

router
  .route('/')
  .post(...canCreateOffers, validate(offerValidation.createOffer), offerController.create)
  .get(...canReadOffers, validate(offerValidation.getOffers), offerController.list);

router
  .route('/:offerId')
  .get(...canReadOffers, validate(offerValidation.getOffer), offerController.get)
  .patch(...canEditOffers, validate(offerValidation.updateOffer), offerController.update)
  .delete(...canDeleteOffers, validate(offerValidation.deleteOffer), offerController.remove);

export default router;
