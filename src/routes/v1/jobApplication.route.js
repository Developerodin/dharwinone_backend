import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as jobApplicationValidation from '../../validations/jobApplication.validation.js';
import * as jobApplicationController from '../../controllers/jobApplication.controller.js';

const router = express.Router();

router
  .route('/')
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(jobApplicationValidation.getJobApplications),
    jobApplicationController.list
  );

router
  .route('/:applicationId')
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(jobApplicationValidation.getJobApplication),
    jobApplicationController.get
  )
  .patch(
    auth(),
    requirePermissions('candidates.manage'),
    validate(jobApplicationValidation.updateJobApplicationStatus),
    jobApplicationController.updateStatus
  );

export default router;
