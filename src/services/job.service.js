import httpStatus from 'http-status';
import XLSX from 'xlsx';
import Job from '../models/job.model.js';
import JobTemplate from '../models/jobTemplate.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Candidate from '../models/candidate.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const isOwnerOrAdmin = async (user, resource) => {
  if (!resource) return false;
  const admin = await userIsAdmin(user);
  if (admin) return true;
  return String(resource.createdBy?._id || resource.createdBy) === String(user.id || user._id);
};

const createJob = async (createdById, payload) => {
  const job = await Job.create({
    createdBy: createdById,
    ...payload,
  });
  return job;
};

const queryJobs = async (filter, options) => {
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

    const result = await Job.paginate(filter, options);
    if (result.results && result.results.length > 0) {
      for (const doc of result.results) {
        await doc.populate([
          { path: 'createdBy', select: 'name email' },
          { path: 'templateId', select: 'name' },
        ]);
      }
    }
    return result;
  }

  // If user is not admin, filter by createdBy
  const isAdmin = await userIsAdmin({ roleIds: filter.userRoleIds || [] });
  if (!isAdmin && filter.userId) {
    const userId = filter.userId;
    const userFilter = { createdBy: userId };

    delete filter.userRoleIds;
    delete filter.userId;

    const finalFilter = { ...filter, ...userFilter };
    const result = await Job.paginate(finalFilter, options);

    if (result.results && result.results.length > 0) {
      for (const doc of result.results) {
        await doc.populate([
          { path: 'createdBy', select: 'name email' },
          { path: 'templateId', select: 'name' },
        ]);
      }
    }

    return result;
  }

  delete filter.userRoleIds;
  delete filter.userId;

  const result = await Job.paginate(filter, options);

  if (result.results && result.results.length > 0) {
    for (const doc of result.results) {
      await doc.populate([
        { path: 'createdBy', select: 'name email' },
        { path: 'templateId', select: 'name' },
      ]);
    }
  }

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
  const canUpdate = await isOwnerOrAdmin(currentUser, job);
  if (!canUpdate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

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
          experienceLevel: row['Experience Level'] || row.Experience || null,
          status: row.Status || 'Active',
        };

        if (!jobData.title || !jobData.organisation.name || !jobData.location) {
          throw new Error('Missing required fields: Title, Organisation Name, and Location are required');
        }

        const validJobTypes = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'];
        if (!validJobTypes.includes(jobData.jobType)) {
          throw new Error(`Invalid job type: ${jobData.jobType}`);
        }

        const validStatuses = ['Draft', 'Active', 'Closed', 'Archived'];
        if (!validStatuses.includes(jobData.status)) {
          throw new Error(`Invalid status: ${jobData.status}`);
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
};
