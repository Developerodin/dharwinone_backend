import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as pmAssistantService from '../services/pmAssistant.service.js';

const previewTaskBreakdown = catchAsync(async (req, res) => {
  const out = await pmAssistantService.previewTaskBreakdown(req.params.projectId, req.user, {
    extraBrief: req.body?.extraBrief,
    feedback: req.body?.feedback,
    priorTasks: req.body?.priorTasks,
    breakdownContext: req.body?.breakdownContext,
  });
  res.status(httpStatus.OK).send(out);
});

const refineTaskBreakdown = catchAsync(async (req, res) => {
  const out = await pmAssistantService.refineTaskBreakdown(req.params.projectId, req.user, {
    previousPreviewId: req.body?.previousPreviewId,
    feedback: req.body?.feedback,
    lockedTaskIds: req.body?.lockedTaskIds,
    breakdownContextOverride: req.body?.breakdownContextOverride,
  });
  res.status(httpStatus.OK).send(out);
});

const applyTaskBreakdown = catchAsync(async (req, res) => {
  const idempotencyKey = req.get('Idempotency-Key') || req.headers['idempotency-key'];
  const out = await pmAssistantService.applyTaskBreakdown(req.params.projectId, req.user, {
    tasks: req.body.tasks,
    idempotencyKey,
    previewId: req.body?.previewId,
  });
  res.status(httpStatus.CREATED).send(out);
});

const createAssignmentRun = catchAsync(async (req, res) => {
  const out = await pmAssistantService.generateAssignmentRun(req.params.projectId, req.user);
  res.status(httpStatus.CREATED).send(out);
});

const getAssignmentRun = catchAsync(async (req, res) => {
  const out = await pmAssistantService.getAssignmentRun(req.params.runId, req.user);
  res.send(out);
});

const patchAssignmentRun = catchAsync(async (req, res) => {
  const out = await pmAssistantService.patchAssignmentRun(req.params.runId, req.user, {
    rows: req.body.rows,
  });
  res.send(out);
});

const approveAssignmentRun = catchAsync(async (req, res) => {
  const out = await pmAssistantService.approveAssignmentRun(req.params.runId, req.user);
  res.send(out);
});

const applyAssignmentRun = catchAsync(async (req, res) => {
  const out = await pmAssistantService.applyAssignmentRun(req.params.runId, req.user);
  res.send(out);
});

const bootstrapSmartTeam = catchAsync(async (req, res) => {
  const out = await pmAssistantService.bootstrapSmartTeamForProject(req.params.projectId, req.user, {
    extraBrief: req.body?.extraBrief,
    breakdownContext: req.body?.breakdownContext,
  });
  res.status(httpStatus.OK).send(out);
});

const submitAssignmentRunFeedback = catchAsync(async (req, res) => {
  const out = await pmAssistantService.submitAssignmentRunFeedback(
    req.params.projectId,
    req.params.runId,
    req.user,
    {
      items: req.body?.items,
      submittedAt: req.body?.submittedAt,
    }
  );
  res.status(httpStatus.ACCEPTED).send(out);
});

const enhanceProjectBrief = catchAsync(async (req, res) => {
  const out = await pmAssistantService.enhanceProjectBrief(req.user, {
    html: req.body?.html,
    projectName: req.body?.projectName,
    projectManager: req.body?.projectManager,
    clientStakeholder: req.body?.clientStakeholder,
    previousEnhancedHtml: req.body?.previousEnhancedHtml,
    refinementInstructions: req.body?.refinementInstructions,
    feedback: req.body?.feedback,
  });
  res.status(httpStatus.OK).send(out);
});

const generateAssignmentRowJobDraft = catchAsync(async (req, res) => {
  const out = await pmAssistantService.generateAssignmentRowJobDraft(
    req.params.runId,
    req.params.rowId,
    req.user,
    { force: !!req.body?.force }
  );
  res.status(httpStatus.OK).send(out);
});

export {
  previewTaskBreakdown,
  refineTaskBreakdown,
  applyTaskBreakdown,
  createAssignmentRun,
  getAssignmentRun,
  patchAssignmentRun,
  approveAssignmentRun,
  applyAssignmentRun,
  bootstrapSmartTeam,
  submitAssignmentRunFeedback,
  enhanceProjectBrief,
  generateAssignmentRowJobDraft,
};
