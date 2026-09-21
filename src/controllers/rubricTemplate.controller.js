import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as rubricTemplateService from '../services/rubricTemplate.service.js';

const actorId = (req) => String(req.user?.id || req.user?._id || '');
const tenantOf = (req) => req.user?.adminId || null;
const accessOf = (req) => ({
  tenantId: tenantOf(req),
  bypassTenant: Boolean(req.user?.platformSuperUser),
});

const create = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.createRubricTemplate(req.body, actorId(req), tenantOf(req));
  res.status(httpStatus.CREATED).send(doc);
});

const list = catchAsync(async (req, res) => {
  const { includeArchived, ...options } = req.query;
  const filter = {
    ...rubricTemplateService.rubricTenantFilter(accessOf(req)),
    ...(includeArchived ? {} : { archivedAt: null }),
  };
  const result = await rubricTemplateService.queryRubricTemplates(filter, options);

  // One aggregation for the page. Editing a shared rubric re-weights every job using it,
  // so the count has to be visible before anyone opens the editor (audit J15).
  const rows = result.results || [];
  const counts = await rubricTemplateService.countJobsByTemplate(rows.map((t) => t.id || t._id));
  result.results = rows.map((t) => ({
    ...(typeof t.toJSON === 'function' ? t.toJSON() : t),
    jobCount: counts.get(String(t.id || t._id)) ?? 0,
  }));

  res.send(result);
});

/** Lets the schedule form preview which rubric a round will be scored against. */
const resolve = catchAsync(async (req, res) => {
  const planKey = req.query.planKey || null;
  const templateId = req.query.templateId || null;
  const resolved = await rubricTemplateService.resolveRubricForRound({
    jobId: req.query.jobId || null,
    roundType: req.query.roundType || null,
    planKey,
    templateId,
    ...accessOf(req),
    enforceTenant: true,
    strictMissing: Boolean(planKey || templateId),
  });
  res.send(resolved);
});

const get = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.getRubricTemplateById(req.params.templateId, accessOf(req));
  res.send(doc);
});

const update = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.updateRubricTemplate(
    req.params.templateId,
    req.body,
    actorId(req),
    accessOf(req)
  );
  res.send(doc);
});

const archive = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.archiveRubricTemplate(
    req.params.templateId,
    actorId(req),
    accessOf(req)
  );
  res.send(doc);
});

const restore = catchAsync(async (req, res) => {
  const doc = await rubricTemplateService.restoreRubricTemplate(
    req.params.templateId,
    actorId(req),
    accessOf(req)
  );
  res.send(doc);
});

/** GET /v1/rubric-templates/:templateId/usage — which jobs reference this rubric. */
const usage = catchAsync(async (req, res) => {
  await rubricTemplateService.getRubricTemplateById(req.params.templateId, accessOf(req));
  const jobs = await rubricTemplateService.jobsUsingTemplate(req.params.templateId);
  res.send({ templateId: req.params.templateId, jobCount: jobs.length, jobs });
});

export default { create, list, resolve, get, update, archive, restore, usage };
