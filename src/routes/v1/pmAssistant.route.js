import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as pmAssistantValidation from '../../validations/pmAssistant.validation.js';
import * as pmAssistantController from '../../controllers/pmAssistant.controller.js';

const router = express.Router();

router
  .route('/enhance-project-brief')
  .post(
    auth(),
    requirePermissions('projects.manage'),
    validate(pmAssistantValidation.enhanceProjectBrief),
    pmAssistantController.enhanceProjectBrief
  );

router
  .route('/projects/:projectId/task-breakdown/preview')
  .post(
    auth(),
    requirePermissions('projects.read'),
    validate(pmAssistantValidation.previewTaskBreakdown),
    pmAssistantController.previewTaskBreakdown
  );

router
  .route('/projects/:projectId/task-breakdown/refine')
  .post(
    auth(),
    requirePermissions('projects.read'),
    validate(pmAssistantValidation.refineTaskBreakdown),
    pmAssistantController.refineTaskBreakdown
  );

router
  .route('/projects/:projectId/task-breakdown/apply')
  .post(
    auth(),
    requirePermissions('projects.manage', 'tasks.manage'),
    validate(pmAssistantValidation.applyTaskBreakdown),
    pmAssistantController.applyTaskBreakdown
  );

router
  .route('/projects/:projectId/bootstrap-smart-team')
  .post(
    auth(),
    requirePermissions('projects.manage', 'tasks.manage', 'teams.manage', 'candidates.read'),
    validate(pmAssistantValidation.bootstrapSmartTeam),
    pmAssistantController.bootstrapSmartTeam
  );

router
  .route('/projects/:projectId/assignment-runs')
  .post(
    auth(),
    requirePermissions('projects.read', 'candidates.read'),
    validate(pmAssistantValidation.projectIdParam),
    pmAssistantController.createAssignmentRun
  );

router
  .route('/projects/:projectId/assignment-runs/:runId/feedback')
  .post(
    auth(),
    requirePermissions('projects.read'),
    validate(pmAssistantValidation.assignmentRunFeedback),
    pmAssistantController.submitAssignmentRunFeedback
  );

router
  .route('/assignment-runs/:runId/rows/:rowId/job-draft')
  .post(
    auth(),
    requirePermissions('projects.read'),
    validate(pmAssistantValidation.assignmentRowJobDraft),
    pmAssistantController.generateAssignmentRowJobDraft
  );

router
  .route('/assignment-runs/:runId')
  .get(auth(), requirePermissions('projects.read'), validate(pmAssistantValidation.runIdParam), pmAssistantController.getAssignmentRun)
  .patch(
    auth(),
    requirePermissions('projects.read'),
    validate(pmAssistantValidation.patchAssignmentRun),
    pmAssistantController.patchAssignmentRun
  );

router
  .route('/assignment-runs/:runId/approve')
  .post(
    auth(),
    requirePermissions('projects.manage'),
    validate(pmAssistantValidation.runIdParam),
    pmAssistantController.approveAssignmentRun
  );

router
  .route('/assignment-runs/:runId/apply')
  .post(
    auth(),
    requirePermissions('projects.manage', 'tasks.manage'),
    validate(pmAssistantValidation.runIdParam),
    pmAssistantController.applyAssignmentRun
  );

export default router;
