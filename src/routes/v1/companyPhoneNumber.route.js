import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as companyPhoneNumberValidation from '../../validations/companyPhoneNumber.validation.js';
import * as companyPhoneNumberController from '../../controllers/companyPhoneNumber.controller.js';

const router = express.Router();

router.get(
  '/user-assignments',
  auth(),
  requireAnyOfPermissions('company-number.read', 'company-number.manage'),
  companyPhoneNumberController.userAssignments,
);

router.post(
  '/assign-user',
  auth(),
  requirePermissions('company-number.manage'),
  validate(companyPhoneNumberValidation.assignPhoneNumberToUser),
  companyPhoneNumberController.assignUser,
);

router.get(
  '/mine',
  auth(),
  requireAnyOfPermissions('company-number.read', 'calls.view'),
  companyPhoneNumberController.myAssigned,
);

router
  .route('/')
  .get(
    auth(),
    requireAnyOfPermissions('company-number.read', 'company-number.manage'),
    validate(companyPhoneNumberValidation.listCompanyPhoneNumbers),
    companyPhoneNumberController.list,
  );

router.post(
  '/sync',
  auth(),
  requirePermissions('company-number.manage'),
  companyPhoneNumberController.syncFromProvider,
);

router.patch(
  '/:id',
  auth(),
  requirePermissions('company-number.manage'),
  validate(companyPhoneNumberValidation.updateCompanyPhoneNumber),
  companyPhoneNumberController.patch,
);

export default router;
