import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as jobApplicationValidation from '../../validations/jobApplication.validation.js';
import * as jobApplicationController from '../../controllers/jobApplication.controller.js';

const router = express.Router();

router
  .route('/my-applications')
  .get(
    auth(),
    validate(jobApplicationValidation.getMyApplications),
    jobApplicationController.getMyApplications
  );

router
  .route('/my-applications/:applicationId')
  .delete(
    auth(),
    validate(jobApplicationValidation.withdrawMyApplication),
    jobApplicationController.withdrawApplication
  );

router
  .route('/')
  .get(
    auth(),
    requirePermissions('candidates.read'),
    validate(jobApplicationValidation.getJobApplications),
    jobApplicationController.list
  )
  .post(
    auth(),
    requirePermissions('candidates.manage'),
    validate(jobApplicationValidation.createJobApplication),
    jobApplicationController.create
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
  )
  .delete(
    auth(),
    requirePermissions('candidates.manage'),
    validate(jobApplicationValidation.deleteJobApplication),
    jobApplicationController.remove
  );

export default router;
