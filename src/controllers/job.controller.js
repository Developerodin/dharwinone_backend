import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
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
  getVacancyFilledMap,
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
import { hasApiPermission } from '../utils/permissionCheck.js';

const auditActorId = (req) => String(req.user?.id || req.user?._id || '');

/**
 * A job's interview rounds and rubric assignments are interview configuration that happens
 * to live on a job document, so `jobs.manage` alone must not set them (audit J11, R15).
 * The job form hides the editor for such a user; this is what makes that a boundary rather
 * than a decoration.
 *
 * Silently stripping the key was the alternative and is worse: the user would see a saved
 * job and believe the rounds took effect.
 *
 * hasOwnProperty, not truthiness — `interviewRounds: []` is a WRITE that removes a job's
 * rounds, and must be gated exactly like setting them.
 *
 * @param {import('express').Request} req
 */
const assertMayWriteInterviewConfig = async (req) => {
  const body = req.body || {};
  const touchesConfig =
    Object.prototype.hasOwnProperty.call(body, 'rubricAssignments') ||
    Object.prototype.hasOwnProperty.call(body, 'interviewRounds');
  if (!touchesConfig) return;

  const allowed = await hasApiPermission(req.user, 'interviews.manage');
  if (!allowed) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'Interview rounds and scoring can only be changed by someone with interview management access.',
      true,
      '',
      { errorCode: 'rubric_requires_interview_access' }
    );
  }
};

// Job CRUD
const create = catchAsync(async (req, res) => {
  await assertMayWriteInterviewConfig(req);
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
  await assertMayWriteInterviewConfig(req);
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

  // Both versioned slots take the same shape: either a saved version number or a fresh file
  // (never both). Multipart sends the number as a string, hence the explicit coercion.
  const readVersion = (raw, label) => {
    if (raw == null || String(raw).trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid ${label} version`);
    }
    return value;
  };

  const resumeVersion = readVersion(req.body?.resumeVersion, 'resume');
  const coverLetterVersion = readVersion(req.body?.coverLetterVersion, 'cover letter');
  const resumeFile = req.files?.resume?.[0];
  const coverLetterFile = req.files?.coverLetter?.[0];
  if (resumeFile && resumeVersion != null) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Provide either resumeVersion or a resume file, not both');
  }
  if (coverLetterFile && coverLetterVersion != null) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Provide either coverLetterVersion or a cover letter file, not both'
    );
  }

  /** Upload to the slot, then read back the version it landed on. Returns the new version number. */
  const saveSlotFile = async (file, slot, s3Folder, label) => {
    const { uploadFileToS3 } = await import('../services/upload.service.js');
    // eslint-disable-next-line import/no-cycle -- lazy import; employee.service also pulls offer.service
    const { attachVersionedSlotUploadToCandidate } = await import('../services/employee.service.js');
    const { latestVersionForSlot } = await import('../utils/documentVersionSlot.js');
    const uploaded = await uploadFileToS3(file, userId, s3Folder);
    await attachVersionedSlotUploadToCandidate(
      candidate,
      slot,
      {
        url: uploaded.url,
        key: uploaded.key,
        originalName: uploaded.originalName,
        size: uploaded.size,
        mimeType: uploaded.mimeType,
      },
      userId,
    );
    candidate = await Employee.findById(candidate._id);
    if (!candidate) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
    }
    const latest = latestVersionForSlot(candidate.documentVersions || [], slot);
    if (!latest?.version) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${label} could not be saved`);
    }
    return Number(latest.version);
  };

  let resolvedResumeVersion = resumeVersion;
  if (resumeFile) {
    resolvedResumeVersion = await saveSlotFile(resumeFile, 'resume', 'candidate-resumes', 'Resume');
  }

  let resolvedCoverLetterVersion = coverLetterVersion;
  if (coverLetterFile) {
    resolvedCoverLetterVersion = await saveSlotFile(
      coverLetterFile,
      'cover-letter',
      'candidate-documents',
      'Cover letter'
    );
  }

  const application = await applyCandidateToJob(jobId, candidate._id, userId, req.user, {
    version: resolvedResumeVersion,
    coverLetterVersion: resolvedCoverLetterVersion,
  });
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

  // Capacity, computed server-side and exposed as one boolean. The raw `vacancies` is deliberately
  // NOT published, and the count is NOT read off these documents: queryJobs returns hydrated docs,
  // where Mongoose fills in the schema default of 1 for a legacy job that never had the field,
  // while the guard reads it lean and treats the same job as uncapped. getVacancyFilledMap answers
  // the question from a lean read so the badge and the guard cannot disagree.
  const vacancyFilledById = await getVacancyFilledMap(result.results.map((j) => j._id ?? j.id));

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
    vacancyFilled: vacancyFilledById.get(String(job._id ?? job.id)) ?? false,
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

  // After the 404, not before: the auto-close tick makes Closed a common outcome for exactly the
  // filled jobs this would be counting, so computing it first spent an aggregation per 404.
  const vacancyFilledById = await getVacancyFilledMap([req.params.jobId]);

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
    vacancyFilled: vacancyFilledById.get(String(req.params.jobId)) ?? false,
  };

  res.send(publicJob);
});

const publicApplyToJob = catchAsync(async (req, res) => {
  // Import publicApplyToJobService dynamically
  const { publicApplyToJobService } = await import('../services/job.service.js');

  const result = await publicApplyToJobService(req.params.jobId, req.body, req.files, { req });

  if (req.files?.coverLetter?.[0] && result?.candidate?.id && result?.user?.id) {
    const candidate = await Employee.findById(result.candidate.id);
    const user = await User.findById(result.user.id);
    if (candidate && user) {
      const { attachPublicApplyCoverLetter } = await import('../services/publicCandidateProfile.service.js');
      await attachPublicApplyCoverLetter(candidate, user, req.files);
    }
  }

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

/**
 * Stream a resume parse to the client as Server-Sent Events.
 *
 * Event types, one JSON object per `data:` frame:
 *   {type:'stage',  stage:'extracting'|'reading', chars?}  progress milestones
 *   {type:'field',  field, value}                          a contact field the model finished
 *   {type:'skill',  name}                                  a skill the model finished
 *   {type:'result', status, warnings, fields}              final payload, identical to the
 *                                                          buffered endpoint's response body
 *   {type:'error',  message}                               unexpected failure, no result follows
 *
 * `result` is authoritative; everything before it is a preview for the UI. A client that loses the
 * connection therefore degrades to "nothing arrived", never to partial data treated as complete.
 */
async function streamResumeParse(req, res) {
  const file = req.file;
  if (!file?.buffer?.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'resume is required (multipart field name: resume)');
  }

  res.writeHead(httpStatus.OK, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers proxied responses by default, which would hold every event back until the
    // request finished — exactly defeating the point of streaming.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });

  const emit = (event) => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const { parseResumeForPublicApplyStream } = await import('../services/resumeSkillsExtract.service.js');
  try {
    await parseResumeForPublicApplyStream(
      file.buffer,
      file.mimetype || 'application/octet-stream',
      file.originalname || 'resume.pdf',
      emit
    );
  } catch (e) {
    // Headers are already sent, so the error middleware cannot help — report in-band instead.
    logger.error('[parsePublicResumeStream] unexpected failure', { message: e?.message });
    emit({ type: 'error', message: 'Resume parsing failed. You can fill in the form manually.' });
  }

  if (!clientGone) res.end();
}

/**
 * POST /v1/public/jobs/:jobId/parse-resume/stream — streaming twin of parsePublicResume.
 */
const parsePublicResumeStream = catchAsync(async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job || job.status !== 'Active') {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  await streamResumeParse(req, res);
});

/**
 * POST /v1/public/parse-resume/stream — streaming twin of parsePublicResumeOnboard.
 */
const parsePublicResumeOnboardStream = catchAsync(async (req, res) => {
  await streamResumeParse(req, res);
});

/**
 * POST /v1/public/parse-resume — AI prefill for candidate onboarding (no job id).
 */
const parsePublicResumeOnboard = catchAsync(async (req, res) => {
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
  parsePublicResumeOnboard,
  parsePublicResumeStream,
  parsePublicResumeOnboardStream,
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
