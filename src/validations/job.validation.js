import Joi from 'joi';
import { rubricAssignmentsError, MAX_RUBRIC_ASSIGNMENTS } from '../constants/interviewRubric.js';
import { roundPlanError, MAX_PLANNED_ROUNDS } from '../constants/interviewRoundPlan.js';
import { objectId, boundedLimit } from './custom.validation.js';

const JOB_TYPE_VALUES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'];

/**
 * Multi job-type list, e.g. "Internship,Part-time". Single values still validate via
 * {@link commaSeparatedJobTypes} or the array branch; service splits via parseStringList.
 */
const commaSeparatedJobTypes = Joi.string().custom((value, helpers) => {
  const parts = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!JOB_TYPE_VALUES.includes(part)) return helpers.error('any.invalid');
  }
  return value;
}, 'comma-separated job types');

const jobTypeListQuery = Joi.alternatives().try(
  Joi.array().items(Joi.string().valid(...JOB_TYPE_VALUES)),
  Joi.string().valid(...JOB_TYPE_VALUES),
  commaSeparatedJobTypes
);

const stringListQuery = Joi.alternatives().try(
  Joi.array().items(Joi.string().trim().min(1)),
  Joi.string().trim().min(1)
);

const COMPANY_SIZE_BUCKETS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'];

const organisation = Joi.object({
  name: Joi.string().required().trim().messages({
    'any.required': 'Organisation name is required',
    'string.empty': 'Organisation name cannot be empty',
  }),
  website: Joi.string().uri().optional().trim().allow('', null).messages({
    'string.uri': 'Website must be a valid URL',
  }),
  email: Joi.string().email().optional().trim().allow('', null),
  phone: Joi.string().optional().trim().allow('', null),
  address: Joi.string().optional().trim().allow('', null),
  description: Joi.string().optional().trim().allow('', null),
  industry: Joi.string().optional().trim().max(120).allow('', null),
  founded: Joi.number().integer().min(1800).max(new Date().getFullYear()).optional().allow(null),
  companySize: Joi.string().valid(...COMPANY_SIZE_BUCKETS).optional().allow('', null),
});

const salaryRange = Joi.object({
  min: Joi.number().optional().allow(null),
  max: Joi.number().optional().allow(null),
  currency: Joi.string().optional().trim().default('USD'),
});

/**
 * A job's interview rubrics.
 *
 * Row shape is checked structurally here; the rules that span rows — exactly one of
 * templateId/criteria, no duplicate round type, weights summing to 100 — come from the one
 * shared validator, so the job form, this schema and the service cannot drift apart.
 *
 * `roundType` is validated by that shared function rather than a Joi `.valid(...)` list,
 * so adding a round type to the constant does not need an edit in two places.
 */
const rubricAssignmentsSchema = Joi.array()
  .items(
    Joi.object({
      roundType: Joi.string().trim().allow(null, ''),
      templateId: Joi.string().custom(objectId).allow(null, ''),
      criteria: Joi.array()
        .items(
          Joi.object({
            key: Joi.string()
              .trim()
              .pattern(/^[a-zA-Z0-9_-]{1,40}$/)
              .required(),
            label: Joi.string().trim().min(1).max(80).required(),
            weight: Joi.number().integer().min(0).max(100).required(),
            scaleMin: Joi.number().integer().min(0).max(9).default(1),
            scaleMax: Joi.number().integer().min(1).max(10).default(5),
          })
        )
        .max(20)
        .allow(null),
    })
  )
  .max(MAX_RUBRIC_ASSIGNMENTS)
  .custom((value, helpers) => {
    const reason = rubricAssignmentsError(value);
    return reason ? helpers.message(reason) : value;
  });

const interviewRoundsSchema = Joi.array()
  .items(
    Joi.object({
      key: Joi.string()
        .trim()
        .pattern(/^[a-z0-9_-]{1,40}$/)
        .required(),
      label: Joi.string().trim().min(1).max(80).required(),
      roundType: Joi.string().trim().allow(null, ''),
      templateId: Joi.string().custom(objectId).allow(null, ''),
      criteria: Joi.array()
        .items(
          Joi.object({
            key: Joi.string()
              .trim()
              .pattern(/^[a-zA-Z0-9_-]{1,40}$/)
              .required(),
            label: Joi.string().trim().min(1).max(80).required(),
            weight: Joi.number().integer().min(0).max(100).required(),
            scaleMin: Joi.number().integer().min(0).max(9).default(1),
            scaleMax: Joi.number().integer().min(1).max(10).default(5),
          })
        )
        .max(20)
        .allow(null),
    })
  )
  .max(MAX_PLANNED_ROUNDS)
  .custom((value, helpers) => {
    const reason = roundPlanError(value);
    return reason ? helpers.message(reason) : value;
  });

// Job Validations
const createJob = {
  body: Joi.object().keys({
    title: Joi.string().required().trim().messages({
      'any.required': 'Job title is required',
      'string.empty': 'Job title cannot be empty',
    }),
    organisation: organisation.required().messages({
      'any.required': 'Organisation details are required',
    }),
    jobDescription: Joi.string().required().trim().messages({
      'any.required': 'Job description is required',
      'string.empty': 'Job description cannot be empty',
    }),
    jobType: Joi.string()
      .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
      .required()
      .messages({
        'any.required': 'Job type is required',
        'any.only':
          'Job type must be one of: Full-time, Part-time, Contract, Temporary, Internship, Freelance',
      }),
    location: Joi.string().required().trim().messages({
      'any.required': 'Location is required',
      'string.empty': 'Location cannot be empty',
    }),
    skillTags: Joi.array().items(Joi.string().trim()).optional(),
    salaryRange: salaryRange.optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional()
      .allow(null),
    minExperience: Joi.number().min(0).max(80).optional().allow(null),
    maxExperience: Joi.number().min(0).max(80).optional().allow(null),
    // Required, and no longer nullable: a job with no declared openings has no hiring cap at all,
    // which is how a 1-vacancy job ended up with two hires. Closing a job is a status change.
    vacancies: Joi.number().integer().min(1).max(10000).required().messages({
      'any.required': 'Vacancies is required and must be at least 1.',
      'number.min':
        'Vacancies must be a whole number of 1 or more. Set the job status to Closed to stop hiring.',
    }),
    applicationDeadline: Joi.date().iso().optional().allow(null),
    status: Joi.string()
      .valid('Draft', 'Active', 'Closed', 'Archived')
      .optional()
      .default('Active'),
    rubricAssignments: rubricAssignmentsSchema.optional(),
    interviewRounds: interviewRoundsSchema.optional(),
    templateId: Joi.string().custom(objectId).optional(),
    templateVariables: Joi.object().optional(),
    interviewerPool: Joi.array().items(Joi.string().custom(objectId)).max(50).optional(),
    assignedRecruiter: Joi.string().custom(objectId).allow(null).optional(),
  }).required(),
};

const searchJobFacet = {
  query: Joi.object().keys({
    facet: Joi.string().valid('title', 'company', 'location').required(),
    q: Joi.string().trim().allow('').optional(),
    limit: Joi.number().integer().min(1).max(50).optional(),
    status: Joi.string().valid('all', 'Draft', 'Active', 'Closed', 'Archived').optional(),
    jobOrigin: Joi.string().valid('internal', 'external').optional().allow('', null),
  }),
};

const getJobs = {
  query: Joi.object().keys({
    title: Joi.string().optional(),
    titles: stringListQuery.optional(),
    companies: stringListQuery.optional(),
    locations: stringListQuery.optional(),
    jobType: Joi.string()
      .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
      .optional(),
    location: Joi.string().optional(),
    status: Joi.string().valid('all', 'Draft', 'Active', 'Closed', 'Archived').optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional(),
    experienceMin: Joi.number().min(0).max(80).optional(),
    experienceMax: Joi.number().min(0).max(80).optional(),
    postingDate: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    createdBy: Joi.string().custom(objectId).optional(),
    search: Joi.string().optional(),
    forCandidates: Joi.boolean().optional(),
    jobOrigin: Joi.string().valid('internal', 'external').optional().allow('', null),
    salaryMin: Joi.number().min(0).optional(),
    salaryMax: Joi.number().min(0).optional(),
    salaryNotSpecified: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false')).optional(),
    sortBy: Joi.string().optional(),
    limit: boundedLimit(100).optional(),
    page: Joi.number().integer().min(1).optional(),
    view: Joi.string().valid('list').optional(),
  }),
};

const getJobFilterOptions = {
  query: Joi.object().keys({
    status: Joi.string().valid('all', 'Draft', 'Active', 'Closed', 'Archived').optional(),
    search: Joi.string().allow('').optional(),
    jobOrigin: Joi.string().valid('internal', 'external').optional().allow('', null),
  }),
};

const getJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
};

const updateJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().optional().trim(),
      organisation: organisation.optional(),
      jobDescription: Joi.string().optional().trim(),
      jobType: Joi.string()
        .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
        .optional(),
      location: Joi.string().optional().trim(),
      skillTags: Joi.array().items(Joi.string().trim()).optional(),
      salaryRange: salaryRange.optional(),
      experienceLevel: Joi.string()
        .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
        .optional()
        .allow(null),
      minExperience: Joi.number().min(0).max(80).optional().allow(null),
      maxExperience: Joi.number().min(0).max(80).optional().allow(null),
      // Optional so a partial update need not resend it, but it can no longer be cleared to null —
      // that would strip an existing job's hiring cap.
      vacancies: Joi.number().integer().min(1).max(10000).optional().messages({
        'number.min':
          'Vacancies must be a whole number of 1 or more. Set the job status to Closed to stop hiring.',
      }),
      applicationDeadline: Joi.date().iso().optional().allow(null),
      status: Joi.string().valid('Draft', 'Active', 'Closed', 'Archived').optional(),
      rubricAssignments: rubricAssignmentsSchema.optional(),
    interviewRounds: interviewRoundsSchema.optional(),
      templateId: Joi.string().custom(objectId).optional(),
      interviewerPool: Joi.array().items(Joi.string().custom(objectId)).max(50).optional(),
      assignedRecruiter: Joi.string().custom(objectId).allow(null).optional(),
    })
    .min(1),
};

const deleteJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
};

const applyToJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    candidateId: Joi.string().custom(objectId).required(),
  }).required(),
};

const shareJobEmail = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    to: Joi.string().email().required(),
    message: Joi.string().optional().allow('', null),
  }).required(),
};

const exportJobs = {
  body: Joi.object().keys({
    ids: Joi.array().items(Joi.string().custom(objectId)).min(1).optional(),
    status: Joi.string().valid('all', 'Draft', 'Active', 'Closed', 'Archived').optional(),
    search: Joi.string().optional(),
    titles: stringListQuery.optional(),
    companies: stringListQuery.optional(),
    locations: stringListQuery.optional(),
    jobOrigin: Joi.string().valid('internal', 'external').optional().allow('', null),
    salaryMin: Joi.number().min(0).optional(),
    salaryMax: Joi.number().min(0).optional(),
    salaryNotSpecified: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false')).optional(),
    experienceMin: Joi.number().min(0).max(80).optional(),
    experienceMax: Joi.number().min(0).max(80).optional(),
    postingDate: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    sortBy: Joi.string().optional(),
  }),
};

const importJobs = {
  body: Joi.object().keys({}),
};

// Job Template Validations
const createJobTemplate = {
  body: Joi.object().keys({
    title: Joi.string().required().trim().messages({
      'any.required': 'Template title is required',
      'string.empty': 'Template title cannot be empty',
    }),
    jobDescription: Joi.string().required().trim().messages({
      'any.required': 'Job description is required',
      'string.empty': 'Job description cannot be empty',
    }),
    visibility: Joi.string().valid('public', 'private').optional(),
    // Optional structured defaults — same shape as Job, none required.
    jobType: Joi.string()
      .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
      .optional()
      .allow(null, ''),
    location: Joi.string().optional().trim().allow(null, ''),
    skillTags: Joi.array().items(Joi.string().trim()).optional(),
    salaryRange: salaryRange.optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional()
      .allow(null, ''),
    education: Joi.string().optional().trim().allow(null, ''),
  }).required(),
};

const getJobTemplates = {
  query: Joi.object().keys({
    title: Joi.string().optional(),
    createdBy: Joi.string().custom(objectId).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getJobTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
};

const updateJobTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().optional().trim(),
      jobDescription: Joi.string().optional().trim(),
      visibility: Joi.string().valid('public', 'private').optional(),
      jobType: Joi.string()
        .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
        .optional()
        .allow(null, ''),
      location: Joi.string().optional().trim().allow(null, ''),
      skillTags: Joi.array().items(Joi.string().trim()).optional(),
      salaryRange: salaryRange.optional(),
      experienceLevel: Joi.string()
        .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
        .optional()
        .allow(null, ''),
      education: Joi.string().optional().trim().allow(null, ''),
    })
    .min(1),
};

const deleteJobTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
};

const createJobFromTemplate = {
  params: Joi.object().keys({
    templateId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    title: Joi.string().required().trim().messages({
      'any.required': 'Job title is required',
      'string.empty': 'Job title cannot be empty',
    }),
    organisation: organisation.required().messages({
      'any.required': 'Organisation details are required',
    }),
    location: Joi.string().required().trim().messages({
      'any.required': 'Location is required',
      'string.empty': 'Location cannot be empty',
    }),
    jobType: Joi.string()
      .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
      .optional(),
    skillTags: Joi.array().items(Joi.string().trim()).optional(),
    salaryRange: salaryRange.optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional()
      .allow(null),
    status: Joi.string()
      .valid('Draft', 'Active', 'Closed', 'Archived')
      .optional()
      .default('Active'),
    jobDescription: Joi.string().optional().trim(),
  }).required(),
};

const browseJobs = {
  query: Joi.object().keys({
    title: Joi.string().optional(),
    jobType: Joi.string()
      .valid(...JOB_TYPE_VALUES)
      .optional(),
    jobTypes: jobTypeListQuery.optional(),
    location: Joi.string().optional().trim(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional(),
    search: Joi.string().optional().trim(),
    jobOrigin: Joi.string().valid('internal', 'external').optional().allow('', null),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(12),
    page: Joi.number().integer().min(1).default(1),
  }),
};

const browseJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
};

const browseApplyToJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    ref: Joi.string().optional().trim().allow(''),
    resumeVersion: Joi.number().integer().min(1).optional(),
    /** Saved cover-letter version to attach. Omitted means the application carries no cover letter. */
    coverLetterVersion: Joi.number().integer().min(1).optional(),
  }),
};

// Public job validations
const listPublicJobs = {
  query: Joi.object().keys({
    title: Joi.string().optional().trim(),
    search: Joi.string().optional().trim(),
    location: Joi.string().optional().trim(),
    jobType: Joi.string()
      .valid(...JOB_TYPE_VALUES)
      .optional(),
    jobTypes: jobTypeListQuery.optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional(),
    jobOrigin: Joi.string().valid('internal', 'external').optional(),
    sortBy: Joi.string().optional().trim(),
    limit: Joi.number().integer().min(1).max(100).default(10),
    page: Joi.number().integer().min(1).default(1),
  }),
};

const getPublicJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
};

const parsePublicResume = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
};

const publicApplyToJob = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    // max: this field is unauthenticated input that ends up inside the voice agent's
    // system prompt. Uncapped, a 200k-character name produced a 403KB user_data payload.
    fullName: Joi.string().required().trim().min(2).max(120)
      .messages({
        'any.required': 'Full name is required',
        'string.empty': 'Full name cannot be empty',
        'string.min': 'Full name must be at least 2 characters',
        'string.max': 'Full name must be 120 characters or fewer',
      }),
    email: Joi.string().email().required().trim().messages({
      'any.required': 'Email is required',
      'string.email': 'Email must be valid',
    }),
    password: Joi.string().required().min(8).messages({
      'any.required': 'Password is required',
      'string.min': 'Password must be at least 8 characters',
    }),
    phoneNumber: Joi.string().required().trim().messages({
      'any.required': 'Phone number is required',
    }),
    countryCode: Joi.string().required().trim().default('US').messages({
      'any.required': 'Country code is required',
    }),
    /** Legacy plain-text or multipart file field `coverLetter`. */
    coverLetter: Joi.alternatives()
      .try(Joi.string().optional().trim().allow('', null), Joi.any().optional())
      .optional(),
    /** HMAC v1 `ref` from job share URL ?ref= (must match job id in token for job-sourced links). */
    ref: Joi.string().trim().allow('', null).optional(),
    /**
     * How the candidate filled the form. `manual` never triggers backend resume skill extraction;
     * `ai` allows parsed skills and server-side fallback when skills are empty.
     * Omitted by older clients — treated as `manual` (safe default).
     */
    entryMode: Joi.string().valid('manual', 'ai').optional().default('manual'),
    /** JSON string array from client-side resume parse prefill; skips re-extraction when valid. */
    skills: Joi.string().trim().allow('', null).optional(),
    /** JSON string arrays from client-side resume parse prefill (experiences, qualifications, socialLinks). */
    experiences: Joi.string().trim().allow('', null).optional(),
    qualifications: Joi.string().trim().allow('', null).optional(),
    socialLinks: Joi.string().trim().allow('', null).optional(),
    // Multipart parsers can surface file field names on req.body while the files
    // themselves are available on req.files via multer.
    resume: Joi.any().optional(),
    documents: Joi.any().optional(),
  }).required(),
};

const listBookmarks = {
  params: Joi.object().keys({ jobId: Joi.string().custom(objectId).required() }),
};

const addBookmark = {
  params: Joi.object().keys({ jobId: Joi.string().custom(objectId).required() }),
  body: Joi.object().keys({
    note: Joi.string().required().trim().max(2000),
    visibility: Joi.string().valid('public', 'private').default('public'),
  }),
};

const deleteBookmark = {
  params: Joi.object().keys({
    jobId: Joi.string().custom(objectId).required(),
    bookmarkId: Joi.string().custom(objectId).required(),
  }),
};

const deleteMyBookmarks = {
  params: Joi.object().keys({ jobId: Joi.string().custom(objectId).required() }),
};

const updateJobAlert = {
  body: Joi.object()
    .keys({
      enabled: Joi.boolean().optional(),
      criteria: Joi.object()
        .keys({
          jobTypes: Joi.array().items(Joi.string().valid(...JOB_TYPE_VALUES)).optional(),
          location: Joi.string().trim().allow('').optional(),
          experienceLevel: Joi.string()
            .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive', '')
            .optional(),
          jobOrigin: Joi.string().valid('internal', 'external', '').optional(),
          search: Joi.string().trim().allow('').optional(),
        })
        .optional(),
      channels: Joi.object()
        .keys({
          email: Joi.boolean().optional(),
          inApp: Joi.boolean().optional(),
        })
        .optional(),
    })
    .min(1),
};

const getJobStats = {
  params: Joi.object().keys({ jobId: Joi.string().custom(objectId).required() }),
};

export {
  createJob,
  getJobs,
  getJobFilterOptions,
  searchJobFacet,
  getJob,
  updateJob,
  deleteJob,
  exportJobs,
  importJobs,
  applyToJob,
  shareJobEmail,
  createJobTemplate,
  getJobTemplates,
  getJobTemplate,
  updateJobTemplate,
  deleteJobTemplate,
  createJobFromTemplate,
  browseJobs,
  browseJob,
  browseApplyToJob,
  listPublicJobs,
  getPublicJob,
  parsePublicResume,
  publicApplyToJob,
  listBookmarks,
  addBookmark,
  deleteBookmark,
  deleteMyBookmarks,
  updateJobAlert,
  getJobStats,
};
