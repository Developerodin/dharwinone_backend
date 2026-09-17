import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as rubricTemplateService from '../services/rubricTemplate.service.js';

const actorId = (req) => String(req.user?.id || req.user?._id || '');
const tenantOf = (req) => req.user?.adminId || null;

const create = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.createRubricTemplate(req.body, actorId(req), tenantOf(req));
  res.status(httpStatus.CREATED).send(doc);
});

const list = catchAsync(async (req, res) => {
  const { includeArchived, ...options } = req.query;
  const filter = includeArchived ? {} : { archivedAt: null };
  const result = await rubricTemplateService.queryRubricTemplates(filter, options);
  res.send(result);
});

/** Lets the schedule form preview which rubric a round will be scored against. */
const resolve = catchAsync(async (req, res) => {
  const resolved = await rubricTemplateService.resolveRubricForRound({
    jobId: req.query.jobId || null,
    roundType: req.query.roundType || null,
  });
  res.send(resolved);
});

const get = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.getRubricTemplateById(req.params.templateId);
  res.send(doc);
});

const update = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.updateRubricTemplate(req.params.templateId, req.body, actorId(req));
  res.send(doc);
});

const archive = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.archiveRubricTemplate(req.params.templateId, actorId(req));
  res.send(doc);
});

const restore = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.restoreRubricTemplate(req.params.templateId, actorId(req));
  res.send(doc);
});

export default { create, list, resolve, get, update, archive, restore };
