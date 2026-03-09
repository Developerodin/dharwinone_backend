import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import { uploadSingle } from '../../middlewares/upload.js';
import * as jobValidation from '../../validations/job.validation.js';
import * as jobController from '../../controllers/job.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('jobs.manage'), validate(jobValidation.createJob), jobController.create)
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.getJobs), jobController.list);

router
  .route('/export/excel')
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.exportJobs), jobController.exportExcel);

router
  .route('/template/excel')
  .get(auth(), requirePermissions('jobs.read'), jobController.getExcelTemplate);

router
  .route('/import/excel')
  .post(auth(), requirePermissions('jobs.manage'), uploadSingle('file'), validate(jobValidation.importJobs), jobController.importExcel);

router
  .route('/templates')
  .post(auth(), requirePermissions('jobs.manage'), validate(jobValidation.createJobTemplate), jobController.createTemplate)
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.getJobTemplates), jobController.listTemplates);

router
  .route('/templates/:templateId')
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.getJobTemplate), jobController.getTemplate)
  .patch(auth(), requirePermissions('jobs.manage'), validate(jobValidation.updateJobTemplate), jobController.updateTemplate)
  .delete(auth(), requirePermissions('jobs.manage'), validate(jobValidation.deleteJobTemplate), jobController.removeTemplate);

router
  .route('/templates/:templateId/create-job')
  .post(
    auth(),
    requirePermissions('jobs.manage'),
    validate(jobValidation.createJobFromTemplate),
    jobController.createFromTemplate
  );

router
  .route('/:jobId/apply')
  .post(auth(), validate(jobValidation.applyToJob), jobController.applyToJob);

router
  .route('/:jobId/share-email')
  .post(auth(), validate(jobValidation.shareJobEmail), jobController.shareJobEmail);

router
  .route('/:jobId')
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.getJob), jobController.get)
  .patch(auth(), requirePermissions('jobs.manage'), validate(jobValidation.updateJob), jobController.update)
  .delete(auth(), requirePermissions('jobs.manage'), validate(jobValidation.deleteJob), jobController.remove);

export default router;
