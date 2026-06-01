import express from 'express';
import auth from '../../middlewares/auth.js';
import optionalAuth from '../../middlewares/optionalAuth.js';
import { jobsBrowseLimiter } from '../../middlewares/rateLimiter.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
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
  // "My jobs template" matrix row derives job-templates.read/manage; honor it alongside legacy jobs.* scope.
  .post(auth(), requireAnyOfPermissions('jobs.manage', 'job-templates.manage'), validate(jobValidation.createJobTemplate), jobController.createTemplate)
  .get(auth(), requireAnyOfPermissions('jobs.read', 'job-templates.read', 'job-templates.manage'), validate(jobValidation.getJobTemplates), jobController.listTemplates);

router
  .route('/templates/:templateId')
  .get(auth(), requireAnyOfPermissions('jobs.read', 'job-templates.read', 'job-templates.manage'), validate(jobValidation.getJobTemplate), jobController.getTemplate)
  .patch(auth(), requireAnyOfPermissions('jobs.manage', 'job-templates.manage'), validate(jobValidation.updateJobTemplate), jobController.updateTemplate)
  .delete(auth(), requireAnyOfPermissions('jobs.manage', 'job-templates.manage'), validate(jobValidation.deleteJobTemplate), jobController.removeTemplate);

router
  .route('/templates/:templateId/create-job')
  .post(
    auth(),
    requirePermissions('jobs.manage'),
    validate(jobValidation.createJobFromTemplate),
    jobController.createFromTemplate
  );

router
  .route('/browse')
  .get(jobsBrowseLimiter, optionalAuth(), validate(jobValidation.browseJobs), jobController.browseJobs);

router
  .route('/browse/:jobId')
  .get(jobsBrowseLimiter, optionalAuth(), validate(jobValidation.browseJob), jobController.browseJobById);

router
  .route('/browse/:jobId/apply')
  .post(auth(), validate(jobValidation.browseJob), jobController.browseApply);

router
  .route('/:jobId/apply')
  .post(auth(), validate(jobValidation.applyToJob), jobController.applyToJob);

router
  .route('/:jobId/share-email')
  .post(auth(), validate(jobValidation.shareJobEmail), jobController.shareJobEmail);

router
  .route('/:jobId/bookmarks')
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.listBookmarks), jobController.listBookmarks)
  .post(auth(), requirePermissions('jobs.read'), validate(jobValidation.addBookmark), jobController.addBookmark);

router
  .route('/:jobId/bookmarks/:bookmarkId')
  .delete(
    auth(),
    requirePermissions('jobs.read'),
    validate(jobValidation.deleteBookmark),
    jobController.deleteBookmark
  );

router
  .route('/:jobId/stats')
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.getJobStats), jobController.jobStats);

router
  .route('/:jobId')
  .get(auth(), requirePermissions('jobs.read'), validate(jobValidation.getJob), jobController.get)
  .patch(auth(), requirePermissions('jobs.manage'), validate(jobValidation.updateJob), jobController.update)
  .delete(auth(), requirePermissions('jobs.manage'), validate(jobValidation.deleteJob), jobController.remove);

export default router;
