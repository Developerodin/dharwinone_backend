import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createJob,
  queryJobs,
  getJobFilterOptions,
  getJobById,
  updateJobById,
  deleteJobById,
  exportJobsToExcel,
  searchJobFacetValues,
  getJobsTemplateBuffer,
  importJobsFromExcel,
  createJobTemplate,
  queryJobTemplates,
  getJobTemplateById,
  updateJobTemplateById,
  deleteJobTemplateById,
  createJobFromTemplate,
  canUserAccessJobTemplate,
  applyCandidateToJob,
  applyJobReferralFromRef,
  listJobBookmarks,
  addJobBookmark,
  deleteJobBookmark,
  getBookmarkedJobIdsForUser,
  deleteMyJobBookmarks,
  getJobStats,
} from '../services/job.service.js';
import { getJobAlertForUser, updateJobAlertForUser } from '../services/jobAlert.service.js';
import { sendJobShareEmail } from '../services/email.service.js';
import { getFrontendBaseUrl } from '../utils/emailLinks.js';
import { mintJobOpenReferralRefWithAudit } from '../services/referralAttribution.service.js';
import { syncReferralPipelineStatusForCandidate } from '../services/referralLeads.service.js';
import { logActivity } from '../services/recruiterActivity.service.js';
import { userHasRecruiterRole, userCanViewAllJobsForListing } from '../utils/roleHelpers.js';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import * as activityLogService from '../services/activityLog.service.js';
import { persistAtsAudit, writeAtsAudit } from '../services/atsAudit.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const auditActorId = (req) => String(req.user?.id || req.user?._id || '');

// Job CRUD
const create = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const job = await createJob(createdById, req.body);

  if (await userHasRecruiterRole(req.user)) {
    await logActivity(createdById, 'job_posting_created', {
      jobId: job._id,
      description: `Created job posting: ${job.title}`,
      metadata: {
        jobTitle: job.title,
        organisation: job.organisation?.name,
        status: job.status,
      },
    });
  }

  const jid = job._id ?? job.id;
  if (jid) {
    await writeAtsAudit(
      String(createdById),
      {
        action: ActivityActions.JOB_CREATE,
        entityType: EntityTypes.JOB,
        entityId: String(jid),
        metadata: { title: job.title, status: job.status },
      },
      req,
      { editContext: { staffEdit: true } }
    );
  }

  res.status(httpStatus.CREATED).send(job);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, [
    'title',
    'titles',
    'companies',
    'locations',
    'jobType',
    'location',
    'status',
    'experienceLevel',
    'experienceMin',
    'experienceMax',
    'postingDate',
    'createdBy',
    'search',
    'forCandidates',
    'jobOrigin',
    'salaryMin',
    'salaryMax',
    'salaryNotSpecified',
  ]);

  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.platformSuperUser = req.user.platformSuperUser;

  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryJobs(filter, options);
  res.send(result);
});

const jobFacetSearch = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['facet', 'q', 'limit', 'status', 'jobOrigin']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.platformSuperUser = req.user.platformSuperUser;
  const values = await searchJobFacetValues(filter);
  res.send({ values });
});

const jobFilterOptions = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'search', 'jobOrigin']);
  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.platformSuperUser = req.user.platformSuperUser;
  const options = await getJobFilterOptions(filter);
  res.send(options);
});

const get = catchAsync(async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }

  const fullVisibility = await userCanViewAllJobsForListing(req.user);
  const isOwner = String(job.createdBy?._id || job.createdBy) === String(req.user.id || req.user._id);
  const isActiveJob = job.status === 'Active';
  if (!fullVisibility && !isOwner && !isActiveJob) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  res.send(job);
});

const update = catchAsync(async (req, res) => {
  const job = await updateJobById(req.params.jobId, req.body, req.user);
  const jid = job?._id ?? job?.id ?? req.params.jobId;
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_UPDATE,
      entityType: EntityTypes.JOB,
      entityId: String(jid),
      metadata: { fieldsUpdated: Object.keys(req.body || {}) },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.send(job);
});

const remove = catchAsync(async (req, res) => {
  await deleteJobById(req.params.jobId, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_DELETE,
      entityType: EntityTypes.JOB,
      entityId: req.params.jobId,
      metadata: {},
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.status(httpStatus.NO_CONTENT).send();
});

// Excel Export
const exportExcel = catchAsync(async (req, res) => {
  const filter = pick(req.body, [
    'status',
    'search',
    'titles',
    'companies',
    'locations',
    'jobOrigin',
    'salaryMin',
    'salaryMax',
    'salaryNotSpecified',
    'experienceMin',
    'experienceMax',
    'postingDate',
    'sortBy',
  ]);

  const { ids } = req.body;
  if (ids?.length) {
    filter._id = { $in: ids };
  }

  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.platformSuperUser = req.user.platformSuperUser;

  const { buffer, capped, totalResults, exportMax } = await exportJobsToExcel(filter);

  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_EXPORT,
      entityType: EntityTypes.JOB,
      entityId: 'bulk',
      metadata: { export: { format: 'xlsx', rowCount: totalResults, capped, exportMax } },
    },
    req,
    { editContext: { staffEdit: true } }
  );

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename=jobs_export_${Date.now()}.xlsx`);
  if (capped) {
    res.setHeader('X-Export-Capped', 'true');
    res.setHeader('X-Export-Total-Results', String(totalResults));
    res.setHeader('X-Export-Max-Rows', String(exportMax));
  }
  res.send(buffer);
});

// Excel Template download
const getExcelTemplate = catchAsync(async (req, res) => {
  const excelBuffer = getJobsTemplateBuffer();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename=jobs_template.xlsx');
  res.send(excelBuffer);
});

// Excel Import
const importExcel = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Excel file is required');
  }

  const createdById = req.user.id || req.user._id;
  const result = await importJobsFromExcel(req.file.buffer, createdById);

  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_IMPORT,
      entityType: EntityTypes.JOB,
      entityId: 'bulk',
      metadata: {
        batch: { successful: result.summary?.successful ?? 0, failed: result.summary?.failed ?? 0 },
      },
    },
    req,
    { editContext: { staffEdit: true } }
  );

  if (result.summary.failed === 0) {
    res.status(httpStatus.CREATED).send({
      message: 'All jobs imported successfully',
      ...result,
    });
  } else if (result.summary.successful === 0) {
    res.status(httpStatus.BAD_REQUEST).send({
      message: 'Failed to import any jobs',
      ...result,
    });
  } else {
    res.status(httpStatus.MULTI_STATUS).send({
      message: 'Some jobs imported successfully, some failed',
      ...result,
    });
  }
});

// Job Template CRUD
const createTemplate = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const template = await createJobTemplate(createdById, req.body);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_TEMPLATE_CREATE,
      entityType: EntityTypes.JOB,
      entityId: String(template._id || template.id),
      metadata: { title: template.title },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.status(httpStatus.CREATED).send(template);
});

const listTemplates = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'createdBy']);

  filter.userRoleIds = req.user.roleIds || [];
  filter.userId = req.user.id || req.user._id;
  filter.platformSuperUser = req.user.platformSuperUser;

  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryJobTemplates(filter, options);
  res.send(result);
});

const getTemplate = catchAsync(async (req, res) => {
  const template = await getJobTemplateById(req.params.templateId);
  if (!template) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job template not found');
  }

  const allowed = await canUserAccessJobTemplate(template, req.user);
  if (!allowed) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job template not found');
  }

  res.send(template);
});

const updateTemplate = catchAsync(async (req, res) => {
  const template = await updateJobTemplateById(req.params.templateId, req.body, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_TEMPLATE_UPDATE,
      entityType: EntityTypes.JOB,
      entityId: String(req.params.templateId),
      metadata: { fieldsUpdated: Object.keys(req.body || {}) },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.send(template);
});

const removeTemplate = catchAsync(async (req, res) => {
  await deleteJobTemplateById(req.params.templateId, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_TEMPLATE_DELETE,
      entityType: EntityTypes.JOB,
      entityId: String(req.params.templateId),
      metadata: {},
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.status(httpStatus.NO_CONTENT).send();
});

// Create job from template
const createFromTemplate = catchAsync(async (req, res) => {
  const createdById = req.user.id || req.user._id;
  const { templateId } = req.params;
  const template = await getJobTemplateById(templateId);
  const job = await createJobFromTemplate(templateId, createdById, req.body, req.user);
  const jid = job?._id ?? job?.id;
  if (jid) {
    await writeAtsAudit(
      auditActorId(req),
      {
        action: ActivityActions.JOB_CREATE_FROM_TEMPLATE,
        entityType: EntityTypes.JOB,
        entityId: String(jid),
        metadata: {
          fromTemplateId: String(templateId),
          templateName: template?.name ?? null,
          title: job.title ?? null,
        },
      },
      req,
      { editContext: { staffEdit: true } }
    );
  }
  res.status(httpStatus.CREATED).send(job);
});

// Apply candidate to job
const applyToJob = catchAsync(async (req, res) => {
  const { jobId } = req.params;
  const { candidateId } = req.body;
  const appliedById = req.user.id || req.user._id;
  const application = await applyCandidateToJob(jobId, candidateId, appliedById, req.user);
  res.status(httpStatus.CREATED).send(application);
});

// Share job via email
const shareJobEmail = catchAsync(async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  const fullVisibility = await userCanViewAllJobsForListing(req.user);
  const isOwner = String(job.createdBy?._id || job.createdBy) === String(req.user.id || req.user._id);
  if (!fullVisibility && !isOwner) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const { to, message } = req.body;
  const jobIdStr = String(job._id || job.id);
  const ref = await mintJobOpenReferralRefWithAudit(req, jobIdStr);
  const jobPublicUrl = `${getFrontendBaseUrl(req)}/public-job/${jobIdStr}?ref=${encodeURIComponent(ref)}`;
  await sendJobShareEmail(to, job, message, {
    sharerName: req.user.name || 'Dharwin team',
    publicJobUrl: jobPublicUrl,
  });
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_SHARE,
      entityType: EntityTypes.JOB,
      entityId: String(job._id || job.id),
      metadata: {
        jobTitle: job.title,
        recipient: to,
        deliveryMethod: 'email',
        hasCustomMessage: Boolean(message && String(message).trim()),
      },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  const { notifyByEmail } = await import('../services/notification.service.js');
  notifyByEmail(to, {
    type: 'general',
    title: `Job shared: ${job.title}`,
    message: `${job.organisation?.name || 'Company'}${job.location ? ` - ${job.location}` : ''}`,
    link: jobPublicUrl,
  }).catch(() => {});
  res.send({ message: 'Job shared successfully' });
});

const browseApply = catchAsync(async (req, res) => {
  const { jobId } = req.params;
  const userId = req.user.id || req.user._id;

  const emailNorm = (req.user.email || '').toLowerCase().trim();
  // Public apply stores candidate.owner as job creator, so logged-in applicants may have no row by owner — match by email too.
  let candidate = await Employee.findOne({ owner: userId });
  if (!candidate && emailNorm) {
    candidate = await Employee.findOne({ email: emailNorm });
  }
  if (!candidate) {
    // Find admin user via roleIds
    const Role = (await import('../models/role.model.js')).default;
    const adminRole = await Role.findOne({ name: 'Administrator', status: 'active' }).select('_id').lean();
    const adminUser = adminRole
      ? await User.findOne({ roleIds: adminRole._id }).select('_id').lean()
      : null;
    if (!adminUser) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'No admin user found to assign candidate');
    }
    const userPhone = (req.user.phoneNumber || '').replace(/\D/g, '');
    candidate = await Employee.create({
      owner: userId,
      adminId: adminUser._id,
      fullName: req.user.name || req.user.email,
      email: emailNorm || req.user.email,
      phoneNumber: userPhone || '0000000000',
      countryCode: req.user.countryCode || undefined,
      isProfileCompleted: userPhone ? 15 : 10,
    });
  }

  const application = await applyCandidateToJob(jobId, candidate._id, userId, req.user);
  const job = await getJobById(jobId);
  const referralRef = req.body?.ref;
  await applyJobReferralFromRef({
    jobId,
    job,
    candidate,
    applicantEmail: emailNorm || req.user.email,
    referralRef,
    req,
  });
  await syncReferralPipelineStatusForCandidate(candidate._id);
  res.status(httpStatus.CREATED).send({ application, candidateId: candidate._id });
});

const browseJobs = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'jobType', 'jobTypes', 'location', 'experienceLevel', 'search', 'jobOrigin']);
  filter.status = 'Active';
  filter.forCandidates = true;
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryJobs(filter, options);
  res.send(result);
});

const browseJobById = catchAsync(async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  if (job.status !== 'Active') {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  res.send(job);
});

// Public job controllers (no auth required)
const listPublicJobs = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'location', 'jobType', 'jobTypes', 'experienceLevel', 'search', 'jobOrigin']);
  // Only show Active jobs publicly; same candidate-facing set as /jobs/browse
  filter.status = 'Active';
  filter.forCandidates = true;

  const options = pick(req.query, ['limit', 'page', 'sortBy']);
  const result = await queryJobs(filter, options);

  // Strip internal fields from public response
  const publicJobs = result.results.map((job) => ({
    id: job._id || job.id,
    title: job.title,
    organisation: job.organisation,
    jobDescription: job.jobDescription,
    jobType: job.jobType,
    location: job.location,
    skillTags: job.skillTags,
    salaryRange: job.salaryRange,
    experienceLevel: job.experienceLevel,
    createdAt: job.createdAt,
    applicationDeadline: job.applicationDeadline,
    status: job.status,
    jobOrigin: job.jobOrigin,
    externalPlatformUrl: job.externalPlatformUrl,
  }));
  
  res.send({
    results: publicJobs,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
    totalResults: result.totalResults,
  });
});

const getPublicJob = catchAsync(async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  
  // Only allow viewing Active jobs publicly
  if (job.status !== 'Active') {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  
  // Strip internal fields (keep flags needed for public UI: internal vs external, apply rules)
  const publicJob = {
    id: job._id || job.id,
    title: job.title,
    organisation: job.organisation,
    jobDescription: job.jobDescription,
    jobType: job.jobType,
    location: job.location,
    skillTags: job.skillTags,
    salaryRange: job.salaryRange,
    experienceLevel: job.experienceLevel,
    createdAt: job.createdAt,
    applicationDeadline: job.applicationDeadline,
    status: job.status,
    jobOrigin: job.jobOrigin,
    externalPlatformUrl: job.externalPlatformUrl,
  };

  res.send(publicJob);
});

const publicApplyToJob = catchAsync(async (req, res) => {
  // Import publicApplyToJobService dynamically
  const { publicApplyToJobService } = await import('../services/job.service.js');

  const result = await publicApplyToJobService(req.params.jobId, req.body, req.files, { req });

  res.status(httpStatus.CREATED).send(result);
});

/**
 * POST /v1/public/jobs/:jobId/parse-resume — AI prefill for public apply (no auth).
 * Does not persist raw resume text or upload the file.
 */
const parsePublicResume = catchAsync(async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job || job.status !== 'Active') {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }

  const file = req.file;
  if (!file?.buffer?.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'resume is required (multipart field name: resume)');
  }

  const { parseResumeForPublicApply } = await import('../services/resumeSkillsExtract.service.js');
  const result = await parseResumeForPublicApply(
    file.buffer,
    file.mimetype || 'application/octet-stream',
    file.originalname || 'resume.pdf'
  );

  res.send(result);
});

// Lightweight existence check for the public apply form: lets the UI show a friendly
// "log in to apply" hint before the user fills the whole form. Returns only a boolean
// (no account details) and is rate-limited at the route to limit enumeration.
const checkPublicEmail = catchAsync(async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  const exists = email ? !!(await User.exists({ email })) : false;
  res.send({ exists });
});

const listBookmarks = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const results = await listJobBookmarks(req.params.jobId, userId);
  res.send({ results });
});

const addBookmark = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const created = await addJobBookmark(req.params.jobId, userId, req.body);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_BOOKMARK_ADD,
      entityType: EntityTypes.JOB,
      entityId: String(req.params.jobId),
      metadata: { bookmarkId: String(created?._id || created?.id || '') },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.status(httpStatus.CREATED).send(created);
});

const deleteBookmark = catchAsync(async (req, res) => {
  await deleteJobBookmark(req.params.jobId, req.params.bookmarkId, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.JOB_BOOKMARK_DELETE,
      entityType: EntityTypes.JOB,
      entityId: String(req.params.jobId),
      metadata: { bookmarkId: String(req.params.bookmarkId) },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.status(httpStatus.NO_CONTENT).send();
});

const listBookmarkedJobIds = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const ids = await getBookmarkedJobIdsForUser(userId);
  res.send({ ids });
});

const deleteMyBookmarks = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const result = await deleteMyJobBookmarks(req.params.jobId, userId);
  res.send(result);
});

const getJobAlert = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const pref = await getJobAlertForUser(userId);
  res.send(pref);
});

const patchJobAlert = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const pref = await updateJobAlertForUser(userId, req.body);
  res.send(pref);
});

const jobStats = catchAsync(async (req, res) => {
  const result = await getJobStats(req.params.jobId, req.user);
  res.send(result);
});

export {
  create,
  list,
  jobFilterOptions,
  jobFacetSearch,
  get,
  update,
  remove,
  exportExcel,
  getExcelTemplate,
  importExcel,
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  removeTemplate,
  createFromTemplate,
  applyToJob,
  shareJobEmail,
  browseApply,
  browseJobs,
  browseJobById,
  listPublicJobs,
  getPublicJob,
  publicApplyToJob,
  parsePublicResume,
  checkPublicEmail,
  listBookmarks,
  addBookmark,
  deleteBookmark,
  listBookmarkedJobIds,
  deleteMyBookmarks,
  getJobAlert,
  patchJobAlert,
  jobStats,
};
