import httpStatus from 'http-status';
import XLSX from 'xlsx';
import Job from '../models/job.model.js';
import JobTemplate from '../models/jobTemplate.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Candidate from '../models/candidate.model.js';
import ExternalJob from '../models/externalJob.model.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import callRecordService from './callRecord.service.js';
import { syncPublishedJobForExternal } from './externalJobPublishedJob.service.js';

/** Matches mirrored external listings in Job (explicit origin or legacy externalRef-only rows). */
const MIRROR_EXTERNAL_OR = {
  $or: [
    { jobOrigin: 'external' },
    {
      'externalRef.externalId': { $exists: true, $nin: [null, ''] },
      'externalRef.source': { $exists: true, $nin: [null, ''] },
    },
  ],
};

/** Single write; keeps listing queries correct for legacy Job rows. */
async function backfillExternalJobOrigin() {
  try {
    const r = await Job.updateMany(
      {
        jobOrigin: { $ne: 'external' },
        'externalRef.externalId': { $exists: true, $nin: [null, ''] },
        'externalRef.source': { $exists: true, $nin: [null, ''] },
      },
      { $set: { jobOrigin: 'external' } }
    );
    if (r.modifiedCount > 0) {
      logger.info(`backfillExternalJobOrigin: set jobOrigin=external on ${r.modifiedCount} job(s)`);
    }
  } catch (e) {
    logger.warn(`backfillExternalJobOrigin: ${e?.message || e}`);
  }
}

/**
 * Sync ExternalJob → Job for orphans / broken publishedJobId (slow; many sequential writes).
 * Not run on every GET /jobs when listing “all” — see throttle below.
 */
async function syncExternalJobMirrors({ cap = 200 }) {
  try {
    const orphans = await ExternalJob.find({
      $or: [{ publishedJobId: null }, { publishedJobId: { $exists: false } }],
    })
      .limit(cap)
      .exec();

    for (const doc of orphans) {
      try {
        await syncPublishedJobForExternal(doc);
      } catch (err) {
        logger.error(
          `syncExternalJobMirrors orphan ${doc.externalId} (${doc.source}): ${err?.message || err}`
        );
      }
    }

    const pinned = await ExternalJob.find({
      publishedJobId: { $exists: true, $ne: null },
    })
      .limit(cap)
      .exec();

    for (const doc of pinned) {
      const stillThere = await Job.exists({ _id: doc.publishedJobId });
      if (!stillThere) {
        await ExternalJob.updateOne({ _id: doc._id }, { $unset: { publishedJobId: 1 } }).exec();
        const fresh = await ExternalJob.findById(doc._id).exec();
        if (fresh) {
          try {
            await syncPublishedJobForExternal(fresh);
          } catch (err) {
            logger.error(`syncExternalJobMirrors resync ${fresh.externalId}: ${err?.message || err}`);
          }
        }
      }
    }
  } catch (e) {
    logger.warn(`syncExternalJobMirrors: ${e?.message || e}`);
  }
}

/**
 * Full orphan/pinned repair is expensive (sequential writes). Throttle so initial load + rapid
 * listing-type toggles (all ↔ external ↔ internal) stay fast when mirrors are already healthy.
 */
let lastFullMirrorSyncAt = 0;
const FULL_MIRROR_SYNC_INTERVAL_MS = 90 * 1000;

const LIST_JOBS_POPULATE = [
  { path: 'createdBy', select: 'name email' },
  { path: 'templateId', select: 'name' },
];

async function maybeRepairMirrorsForList(jobOriginMode) {
  if (jobOriginMode !== 'external' && jobOriginMode !== 'all') return;

  await backfillExternalJobOrigin();

  const anyOrphan = await ExternalJob.exists({
    $or: [{ publishedJobId: null }, { publishedJobId: { $exists: false } }],
  });
  if (!anyOrphan) return;

  const now = Date.now();
  const allowFullBatch = now - lastFullMirrorSyncAt >= FULL_MIRROR_SYNC_INTERVAL_MS;
  if (allowFullBatch) lastFullMirrorSyncAt = now;

  const cap = allowFullBatch
    ? jobOriginMode === 'external'
      ? 220
      : 90
    : 20;

  await syncExternalJobMirrors({ cap });
}

const CLIENT_FORBIDDEN_JOB_FIELDS = ['jobOrigin', 'externalRef', 'externalPlatformUrl'];

function stripForbiddenJobFields(body) {
  if (!body || typeof body !== 'object') return;
  CLIENT_FORBIDDEN_JOB_FIELDS.forEach((k) => {
    delete body[k];
  });
}

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const createJob = async (createdById, payload) => {
  stripForbiddenJobFields(payload);
  const job = await Job.create({
    createdBy: createdById,
    ...payload,
  });
  return job;
};

const queryJobs = async (filter, options) => {
  let jobOriginMode = 'all';
  if (filter.jobOrigin === 'internal') jobOriginMode = 'internal';
  else if (filter.jobOrigin === 'external') jobOriginMode = 'external';
  delete filter.jobOrigin;

  await maybeRepairMirrorsForList(jobOriginMode);

  // Handle search query
  if (filter.search) {
    const searchRegex = new RegExp(filter.search, 'i');
    filter.$or = [
      { title: searchRegex },
      { 'organisation.name': searchRegex },
      { jobDescription: searchRegex },
      { location: searchRegex },
      { skillTags: { $in: [searchRegex] } },
    ];
    delete filter.search;
  }

  // Candidate-facing: return all active jobs, no createdBy filter
  if (filter.forCandidates) {
    delete filter.forCandidates;
    delete filter.userRoleIds;
    delete filter.userId;
    filter.status = 'Active';

    if (jobOriginMode === 'internal') {
      filter.jobOrigin = { $ne: 'external' };
    } else if (jobOriginMode === 'external') {
      const status = filter.status;
      delete filter.status;
      filter.$and = [{ status }, MIRROR_EXTERNAL_OR];
    }

    const result = await Job.paginate(filter, { ...options, populate: LIST_JOBS_POPULATE });
    return result;
  }

  // If user is not admin: own internal jobs + all mirrored external jobs (tenant-wide listings)
  const isAdmin = await userIsAdmin({ roleIds: filter.userRoleIds || [] });
  if (!isAdmin && filter.userId) {
    const userId = filter.userId;

    delete filter.userRoleIds;
    delete filter.userId;

    const searchOr = filter.$or;
    const rest = { ...filter };
    if (searchOr) delete rest.$or;

    const searchClause = searchOr ? { $or: searchOr } : null;

    let finalFilter;
    if (jobOriginMode === 'internal') {
      const mineInternal = { ...rest, createdBy: userId, jobOrigin: { $ne: 'external' } };
      finalFilter = searchClause ? { $and: [searchClause, mineInternal] } : mineInternal;
    } else if (jobOriginMode === 'external') {
      const clauses = [MIRROR_EXTERNAL_OR];
      if (Object.keys(rest).length > 0) clauses.unshift(rest);
      if (searchClause) clauses.unshift(searchClause);
      finalFilter = clauses.length === 1 ? clauses[0] : { $and: clauses };
    } else {
      const visibilityClause = {
        $or: [{ createdBy: userId }, MIRROR_EXTERNAL_OR],
      };
      finalFilter = searchClause
        ? { ...rest, $and: [searchClause, visibilityClause] }
        : { ...rest, ...visibilityClause };
    }

    const result = await Job.paginate(finalFilter, { ...options, populate: LIST_JOBS_POPULATE });
    return result;
  }

  delete filter.userRoleIds;
  delete filter.userId;

  if (jobOriginMode === 'internal') {
    filter.jobOrigin = { $ne: 'external' };
  } else if (jobOriginMode === 'external') {
    const base = { ...filter };
    Object.keys(filter).forEach((k) => delete filter[k]);
    const clauses = [MIRROR_EXTERNAL_OR];
    if (Object.keys(base).length > 0) clauses.unshift(base);
    filter.$and = clauses;
  }

  const result = await Job.paginate(filter, { ...options, populate: LIST_JOBS_POPULATE });
  return result;
};

const getJobById = async (id) => {
  const job = await Job.findById(id).exec();
  if (!job) {
    return null;
  }

  await job.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'templateId', select: 'name description' },
  ]);

  return job;
};

const updateJobById = async (id, updateBody, currentUser) => {
  const job = await getJobById(id);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  if (job.jobOrigin === 'external') {
    throw new ApiError(httpStatus.FORBIDDEN, 'External jobs cannot be edited in ATS. Manage them from External jobs.');
  }
  const canUpdate = await isOwnerOrAdmin(currentUser, job);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  stripForbiddenJobFields(updateBody);
  Object.assign(job, updateBody);
  await job.save();

  await job.populate([
    { path: 'createdBy', select: 'name email' },
    { path: 'templateId', select: 'name' },
  ]);

  return job;
};

const deleteJobById = async (id, currentUser) => {
  const job = await getJobById(id);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  if (job.jobOrigin === 'external') {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'External mirrored jobs cannot be deleted here. Remove the listing from External jobs instead.'
    );
  }
  const canDelete = await isOwnerOrAdmin(currentUser, job);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  await job.deleteOne();
  return job;
};

// Excel Export
const exportJobsToExcel = async (filters = {}) => {
  const isAdmin = await userIsAdmin({ roleIds: filters.userRoleIds || [] });
  if (!isAdmin && filters.userId) {
    filters.createdBy = filters.userId;
  }
  delete filters.userRole;
  delete filters.userId;
  delete filters.userRoleIds;

  const jobs = await Job.find(filters)
    .populate('createdBy', 'name email')
    .populate('templateId', 'name')
    .sort({ createdAt: -1 });

  const exportData = jobs.map((job) => ({
    'Job Title': job.title,
    'Organisation Name': job.organisation?.name || '',
    'Organisation Website': job.organisation?.website || '',
    'Organisation Email': job.organisation?.email || '',
    'Organisation Phone': job.organisation?.phone || '',
    'Organisation Address': job.organisation?.address || '',
    'Job Type': job.jobType,
    'Location': job.location,
    'Skill Tags': job.skillTags?.join('; ') || '',
    'Job Description': job.jobDescription || '',
    'Salary Min': job.salaryRange?.min || '',
    'Salary Max': job.salaryRange?.max || '',
    'Salary Currency': job.salaryRange?.currency || '',
    'Experience Level': job.experienceLevel || '',
    'Status': job.status,
    'Template Used': job.templateId?.name || '',
    'Created By': job.createdBy?.name || '',
    'Created At': job.createdAt ? new Date(job.createdAt).toISOString() : '',
    'Updated At': job.updatedAt ? new Date(job.updatedAt).toISOString() : '',
  }));

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(exportData);

  const columnWidths = [
    { wch: 20 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 20 },
    { wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 30 }, { wch: 50 },
    { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 18 }, { wch: 12 },
    { wch: 20 }, { wch: 20 }, { wch: 25 }, { wch: 25 },
  ];
  worksheet['!cols'] = columnWidths;

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Jobs');

  const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  return excelBuffer;
};

// Excel Template (headers + sample row for import)
const getJobsTemplateBuffer = () => {
  const headers = [{
    'Job Title': 'Senior Software Engineer',
    'Organisation Name': 'Acme Corp',
    'Organisation Website': 'https://acme.com',
    'Organisation Email': 'hr@acme.com',
    'Organisation Phone': '+1 234 567 8900',
    'Organisation Address': '123 Main St, City, State',
    'Job Type': 'Full-time',
    'Location': 'San Francisco, CA',
    'Skill Tags': 'JavaScript; React; Node.js',
    'Job Description': 'We are looking for an experienced software engineer...',
    'Salary Min': 80000,
    'Salary Max': 120000,
    'Salary Currency': 'USD',
    'Experience Level': 'Mid Level',
    'Status': 'Active',
  }];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(headers);
  
  // Add data validation notes as a second row
  const notes = {
    'Job Title': '(Required)',
    'Organisation Name': '(Required)',
    'Organisation Website': '',
    'Organisation Email': '',
    'Organisation Phone': '',
    'Organisation Address': '',
    'Job Type': 'Full-time | Part-time | Contract | Temporary | Internship | Freelance',
    'Location': '(Required)',
    'Skill Tags': 'Separate with semicolons (;)',
    'Job Description': '(Required)',
    'Salary Min': 'Number',
    'Salary Max': 'Number',
    'Salary Currency': 'USD, EUR, GBP, etc.',
    'Experience Level': 'Entry Level | Mid Level | Senior Level | Executive (or Junior, Mid, Senior)',
    'Status': 'Active | Draft | Closed | Archived',
  };
  XLSX.utils.sheet_add_json(worksheet, [notes], { skipHeader: true, origin: -1 });
  
  worksheet['!cols'] = [
    { wch: 20 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 20 },
    { wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 30 }, { wch: 50 },
    { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 18 }, { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Jobs');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

// Excel Import
const importJobsFromExcel = async (fileBuffer, createdById) => {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    const results = {
      successful: [],
      failed: [],
      summary: {
        total: data.length,
        successful: 0,
        failed: 0,
      },
    };

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        // Normalize experience level to match enum values
        const normalizeExperienceLevel = (level) => {
          if (!level) return null;
          const normalized = String(level).trim();
          const mapping = {
            'junior': 'Entry Level',
            'entry': 'Entry Level',
            'entry level': 'Entry Level',
            'mid': 'Mid Level',
            'mid level': 'Mid Level',
            'middle': 'Mid Level',
            'senior': 'Senior Level',
            'senior level': 'Senior Level',
            'sr': 'Senior Level',
            'executive': 'Executive',
            'exec': 'Executive',
            'lead': 'Senior Level',
            'principal': 'Senior Level',
          };
          return mapping[normalized.toLowerCase()] || normalized;
        };

        const jobData = {
          title: row['Job Title'] || row.Title || '',
          organisation: {
            name: row['Organisation Name'] || row['Organization Name'] || row['Company Name'] || '',
            website: row['Organisation Website'] || row.Website || '',
            email: row['Organisation Email'] || row.Email || '',
            phone: row['Organisation Phone'] || row.Phone || '',
            address: row['Organisation Address'] || row.Address || '',
            description: row['Organisation Description'] || row['Company Description'] || '',
          },
          jobType: row['Job Type'] || row.Type || 'Full-time',
          location: row.Location || '',
          jobDescription: row['Job Description'] || row.Description || '',
          skillTags: (row['Skill Tags'] || row.Skills || '')
            ? String(row['Skill Tags'] || row.Skills || '').split(';').map((tag) => tag.trim()).filter((tag) => tag)
            : [],
          salaryRange: {
            min: row['Salary Min'] || row['Min Salary'] || null,
            max: row['Salary Max'] || row['Max Salary'] || null,
            currency: row['Salary Currency'] || row.Currency || 'USD',
          },
          experienceLevel: normalizeExperienceLevel(row['Experience Level'] || row.Experience),
          status: row.Status || 'Active',
        };

        if (!jobData.title || !jobData.organisation.name || !jobData.location) {
          throw new Error('Missing required fields: Title, Organisation Name, and Location are required');
        }

        const validJobTypes = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'];
        if (!validJobTypes.includes(jobData.jobType)) {
          throw new Error(`Invalid job type: ${jobData.jobType}. Must be one of: ${validJobTypes.join(', ')}`);
        }

        const validExperienceLevels = ['Entry Level', 'Mid Level', 'Senior Level', 'Executive'];
        if (jobData.experienceLevel && !validExperienceLevels.includes(jobData.experienceLevel)) {
          throw new Error(`Invalid experience level: ${jobData.experienceLevel}. Must be one of: ${validExperienceLevels.join(', ')}, or common variations like Junior, Senior, Mid, etc.`);
        }

        const validStatuses = ['Draft', 'Active', 'Closed', 'Archived'];
        if (!validStatuses.includes(jobData.status)) {
          throw new Error(`Invalid status: ${jobData.status}. Must be one of: ${validStatuses.join(', ')}`);
        }

        const job = await createJob(createdById, jobData);
        results.successful.push({
          row: i + 2,
          jobId: job.id,
          title: job.title,
        });
        results.summary.successful += 1;
      } catch (error) {
        results.failed.push({
          row: i + 2,
          error: error.message || 'Unknown error',
          data: row,
        });
        results.summary.failed += 1;
      }
    }

    return results;
  } catch (error) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Failed to import jobs: ${error.message}`);
  }
};

// Job Template CRUD
const createJobTemplate = async (createdById, payload) => {
  const template = await JobTemplate.create({
    createdBy: createdById,
    ...payload,
  });
  return template;
};

const queryJobTemplates = async (filter, options) => {
  const isAdmin = await userIsAdmin({ roleIds: filter.userRoleIds || [] });
  if (!isAdmin && filter.userId) {
    const userId = filter.userId;
    const userFilter = { createdBy: userId };

    delete filter.userRoleIds;
    delete filter.userId;

    const finalFilter = { ...filter, ...userFilter };
    const result = await JobTemplate.paginate(finalFilter, options);

    if (result.results && result.results.length > 0) {
      for (const doc of result.results) {
        await doc.populate([{ path: 'createdBy', select: 'name email' }]);
      }
    }

    return result;
  }

  delete filter.userRoleIds;
  delete filter.userId;

  const result = await JobTemplate.paginate(filter, options);

  if (result.results && result.results.length > 0) {
    for (const doc of result.results) {
      await doc.populate([{ path: 'createdBy', select: 'name email' }]);
    }
  }

  return result;
};

const getJobTemplateById = async (id) => {
  const template = await JobTemplate.findById(id).exec();
  if (!template) {
    return null;
  }

  await template.populate([{ path: 'createdBy', select: 'name email' }]);

  return template;
};

const updateJobTemplateById = async (id, updateBody, currentUser) => {
  const template = await getJobTemplateById(id);
  if (!template) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job template not found');
  }
  const canUpdate = await isOwnerOrAdmin(currentUser, template);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  Object.assign(template, updateBody);
  await template.save();

  await template.populate([{ path: 'createdBy', select: 'name email' }]);

  return template;
};

const deleteJobTemplateById = async (id, currentUser) => {
  const template = await getJobTemplateById(id);
  if (!template) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job template not found');
  }
  const canDelete = await isOwnerOrAdmin(currentUser, template);
  if (!canDelete) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  await template.deleteOne();
  return template;
};

const applyCandidateToJob = async (jobId, candidateId, appliedById, currentUser) => {
  const job = await getJobById(jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  if (job.status !== 'Active') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot apply to a job that is not active');
  }
  const canAccessJob = await isOwnerOrAdmin(currentUser, job);
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  const isSelfApply = String(candidate.owner) === String(currentUser.id || currentUser._id);
  if (!canAccessJob && !isSelfApply) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const existing = await JobApplication.findOne({ job: jobId, candidate: candidateId });
  if (existing) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Candidate has already applied to this job');
  }
  const application = await JobApplication.create({
    job: jobId,
    candidate: candidateId,
    appliedBy: appliedById,
    status: 'Applied',
  });
  await application.populate([{ path: 'candidate', select: 'fullName email' }, { path: 'job', select: 'title' }]);
  return application;
};

const createJobFromTemplate = async (templateId, createdById, jobData) => {
  const template = await getJobTemplateById(templateId);
  if (!template) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job template not found');
  }

  const finalJobData = {
    ...jobData,
    jobDescription: jobData.jobDescription || template.jobDescription,
    templateId: templateId,
  };

  const job = await createJob(createdById, finalJobData);

  template.usageCount += 1;
  template.lastUsedAt = new Date();
  await template.save();

  return job;
};

/**
 * Public apply to job service
 * Creates user, candidate with resume, and job application in one transaction
 * Returns auth tokens for auto-login
 */
const publicApplyToJobService = async (jobId, applicationData, files) => {
  // Import necessary services
  const User = (await import('../models/user.model.js')).default;
  const { generateAuthTokens } = await import('./token.service.js');

  // Validate job exists and is Active
  const job = await getJobById(jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  if (job.status !== 'Active') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This job is no longer accepting applications');
  }

  const { fullName, email, password, phoneNumber, countryCode, coverLetter } = applicationData;

  // Check if user with this email already exists
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'An account with this email already exists. Please login to apply.'
    );
  }

  // Get Student role for auto-assignment
  const { getRoleByName } = await import('./role.service.js');
  const studentRole = await getRoleByName('Student');
  if (!studentRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Student role not found. Please contact administrator.');
  }

  // Create new user with Student role (active status for auto-login)
  const user = await User.create({
    name: fullName,
    email: email.toLowerCase(),
    password,
    phoneNumber,
    countryCode,
    roleIds: [studentRole._id], // Assign Student role
    status: 'active',
  });

  // Handle file uploads to S3
  let resumeUrl = null;
  const documentUrls = [];

  if (files?.resume && files.resume[0]) {
    const { uploadFileToS3 } = await import('./upload.service.js');
    const resumeFile = files.resume[0];
    const uploadResult = await uploadFileToS3(resumeFile, user._id, 'candidate-resumes');
    resumeUrl = uploadResult.fileUrl;
  }

  if (files?.documents && files.documents.length > 0) {
    const { uploadFileToS3 } = await import('./upload.service.js');
    for (const doc of files.documents) {
      const uploadResult = await uploadFileToS3(doc, user._id, 'candidate-documents');
      documentUrls.push({
        name: doc.originalname,
        url: uploadResult.fileUrl,
      });
    }
  }

  // Create candidate profile with minimal info + resume
  // For public applications, assign to the job creator (admin) so they're visible in candidates list
  const jobCreatorId = job.createdBy || job.owner;
  
  // Check if candidate with this email already exists
  let candidate = await Candidate.findOne({ email: email.toLowerCase() });
  
  if (!candidate) {
    const candidateData = {
      owner: jobCreatorId || user._id, // Assign to job creator/owner, fallback to self
      adminId: jobCreatorId || user._id, // Use same for adminId
      fullName,
      email: email.toLowerCase(),
      phoneNumber,
      countryCode,
      // Default empty arrays for required fields
      qualifications: [],
      experiences: [],
      skills: [],
      socialLinks: [],
    };

    if (resumeUrl) {
      candidateData.documents = [{ name: 'Resume', url: resumeUrl }];
    }

    if (documentUrls.length > 0) {
      candidateData.documents = [...(candidateData.documents || []), ...documentUrls];
    }

    candidate = await Candidate.create(candidateData);
    console.log('✅ New candidate created:', { _id: candidate._id, fullName: candidate.fullName, email: candidate.email });
  } else {
    console.log('✅ Existing candidate found:', { _id: candidate._id, fullName: candidate.fullName, email: candidate.email });
    
    // Update phone number if it changed
    if (candidate.phoneNumber !== phoneNumber || candidate.countryCode !== countryCode) {
      candidate.phoneNumber = phoneNumber;
      candidate.countryCode = countryCode;
      await candidate.save();
      console.log('✅ Candidate phone updated');
    }
    
    // Add new documents if provided
    if (resumeUrl || documentUrls.length > 0) {
      const newDocs = [];
      if (resumeUrl) newDocs.push({ name: 'Resume', url: resumeUrl });
      if (documentUrls.length > 0) newDocs.push(...documentUrls);
      
      candidate.documents = [...(candidate.documents || []), ...newDocs];
      await candidate.save();
      console.log('✅ Candidate documents updated');
    }
  }

  // Create job application
  const application = await JobApplication.create({
    job: jobId,
    candidate: candidate._id,
    appliedBy: user._id,
    status: 'Applied',
    coverLetter: coverLetter || '',
  });
  console.log('✅ Job application created:', { _id: application._id, candidate: application.candidate, job: application.job });

  await application.populate([
    { path: 'candidate', select: 'fullName email phoneNumber' },
    { path: 'job', select: 'title organisation' },
  ]);
  console.log('✅ Job application populated:', { 
    _id: application._id, 
    candidateData: application.candidate ? { 
      _id: application.candidate._id, 
      fullName: application.candidate.fullName, 
      email: application.candidate.email 
    } : null 
  });

  // Generate auth tokens for auto-login
  const tokens = await generateAuthTokens(user);

  // Send welcome email with login credentials (async, don't wait)
  const config = (await import('../config/config.js')).default;
  const { sendJobApplicationWelcomeEmail } = await import('./email.service.js');
  const loginUrl = `${config.frontendBaseUrl || 'http://localhost:3001'}/authentication/sign-in/`;
  
  sendJobApplicationWelcomeEmail(user.email, {
    fullName,
    email: user.email,
    password, // Plain password before hashing
    jobTitle: job.title,
    companyName: job.organisation?.name || 'Company',
    loginUrl,
  }).catch((err) => {
    console.error('Failed to send welcome email:', err);
    // Don't fail the application if email fails
  });

  // Initiate verification call via Bolna (async, don't wait) — skip for external listings
  if (phoneNumber && countryCode && job.jobOrigin !== 'external') {
    try {
      const bolnaService = (await import('./bolna.service.js')).default;
      const { numberToWords, currencyToWords } = await import('../utils/numberToWords.js');
      
      console.log(`Processing phone for ${fullName}: Raw="${phoneNumber}", Country="${countryCode}"`);
      
      // Format phone number to E.164 - more robust handling
      let formattedPhone = String(phoneNumber).replace(/\D/g, ''); // Remove all non-digits
      
      console.log(`After digit extraction: "${formattedPhone}"`);
      
      // If phone already starts with country code digits, use as is
      // Otherwise, add country prefix
      if (!formattedPhone.startsWith('91') && !formattedPhone.startsWith('1') && 
          !formattedPhone.startsWith('44') && !formattedPhone.startsWith('61')) {
        const countryPrefix = countryCode === 'IN' ? '91' : 
                             countryCode === 'US' ? '1' : 
                             countryCode === 'GB' ? '44' : 
                             countryCode === 'AU' ? '61' : '1';
        formattedPhone = countryPrefix + formattedPhone;
        console.log(`Added country prefix: "${formattedPhone}"`);
      }
      
      // Add '+' prefix for E.164 format
      formattedPhone = '+' + formattedPhone;
      
      console.log(`Final formatted phone: "${formattedPhone}" (length: ${formattedPhone.length})`);
      
      // Validate phone number length (check digits only, not the + sign)
      const digitsOnly = formattedPhone.replace(/\D/g, '');
      if (digitsOnly.length < 10 || digitsOnly.length > 15) {
        console.warn(`⚠️ Invalid phone number format for ${fullName}: ${formattedPhone} (digits: ${digitsOnly.length})`);
        // Skip call but don't fail the application
      } else {
        // Format salary range for voice
        let salaryRange = '';
        if (job.salaryRange) {
          const { min, max, currency } = job.salaryRange;
          const curr = currencyToWords(currency || 'USD');
          if (min != null && max != null) {
            salaryRange = `${numberToWords(min)} to ${numberToWords(max)} ${curr} per year`;
          } else if (min != null) {
            salaryRange = `From ${numberToWords(min)} ${curr} per year`;
          } else if (max != null) {
            salaryRange = `Up to ${numberToWords(max)} ${curr} per year`;
          }
        }

        // Prepare context for Bolna agent
        const callContext = {
          phone: formattedPhone,
          agentId: config.bolna.candidateAgentId, // Use candidate agent ID
          candidate_name: fullName,
          candidate_email: email,
          job_title: job.title,
          job_type: job.employmentType || 'Full-time',
          location: `${job.location || 'Remote'}${job.workMode ? ` - ${job.workMode}` : ''}`,
          experience_level: job.experienceLevel || 'Not specified',
          salary_range: salaryRange || 'Competitive salary based on experience',
          company_name: job.organisation?.name || 'Our Company',
          application_date: new Date(application.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
        };

        // Initiate call
        bolnaService.initiateCall(callContext).then((result) => {
          if (result.success && result.executionId) {
            // Update application with call details
            JobApplication.updateOne(
              { _id: application._id },
              {
                $set: {
                  verificationCallExecutionId: result.executionId,
                  verificationCallInitiatedAt: new Date(),
                  verificationCallStatus: 'pending',
                },
              }
            ).catch((err) => {
              console.error('Failed to update application with call details:', err);
            });

            // Create call record
            callRecordService.createRecord({
              executionId: result.executionId,
              recipientPhone: formattedPhone,
              recipientName: fullName,
              recipientEmail: email,
              purpose: 'job_application_verification',
              relatedJobApplication: application._id,
              relatedJob: job._id,
              relatedCandidate: candidate._id,
              status: 'initiated',
            }).catch((err) => {
              console.error('Failed to create call record:', err);
            });

            console.log(`✅ Verification call initiated for ${fullName} (${formattedPhone}) - Execution: ${result.executionId}`);
          } else {
            console.warn(`❌ Verification call failed for ${fullName}: ${result.error || 'unknown error'}`);
          }
        }).catch((err) => {
          console.error('Failed to initiate verification call:', err);
          // Don't fail the application if call fails
        });
      }
    } catch (err) {
      console.error(`Error in call initiation for ${fullName}:`, err);
      // Don't fail the application if call fails
    }
  }

  return {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
    },
    candidate: {
      id: candidate._id,
      fullName: candidate.fullName,
    },
    application: {
      id: application._id,
      status: application.status,
      jobTitle: application.job?.title,
    },
    tokens,
  };
};

export {
  createJob,
  queryJobs,
  getJobById,
  updateJobById,
  deleteJobById,
  exportJobsToExcel,
  getJobsTemplateBuffer,
  importJobsFromExcel,
  createJobTemplate,
  queryJobTemplates,
  getJobTemplateById,
  updateJobTemplateById,
  deleteJobTemplateById,
  createJobFromTemplate,
  applyCandidateToJob,
  isOwnerOrAdmin,
  publicApplyToJobService,
};
