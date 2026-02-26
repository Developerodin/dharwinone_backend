import Joi from 'joi';
import { objectId } from './custom.validation.js';

const organisation = Joi.object({
  name: Joi.string().required().trim().messages({
    'any.required': 'Organisation name is required',
    'string.empty': 'Organisation name cannot be empty',
  }),
  website: Joi.string().uri().optional().trim().allow('', null),
  email: Joi.string().email().optional().trim().allow('', null),
  phone: Joi.string().optional().trim().allow('', null),
  address: Joi.string().optional().trim().allow('', null),
  description: Joi.string().optional().trim().allow('', null),
});

const salaryRange = Joi.object({
  min: Joi.number().optional().allow(null),
  max: Joi.number().optional().allow(null),
  currency: Joi.string().optional().trim().default('USD'),
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
    status: Joi.string()
      .valid('Draft', 'Active', 'Closed', 'Archived')
      .optional()
      .default('Active'),
    templateId: Joi.string().custom(objectId).optional(),
    templateVariables: Joi.object().optional(),
  }).required(),
};

const getJobs = {
  query: Joi.object().keys({
    title: Joi.string().optional(),
    jobType: Joi.string()
      .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
      .optional(),
    location: Joi.string().optional(),
    status: Joi.string().valid('Draft', 'Active', 'Closed', 'Archived').optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional(),
    createdBy: Joi.string().custom(objectId).optional(),
    search: Joi.string().optional(),
    forCandidates: Joi.boolean().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
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
      status: Joi.string().valid('Draft', 'Active', 'Closed', 'Archived').optional(),
      templateId: Joi.string().custom(objectId).optional(),
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
  query: Joi.object().keys({
    title: Joi.string().optional(),
    jobType: Joi.string()
      .valid('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance')
      .optional(),
    location: Joi.string().optional(),
    status: Joi.string().valid('Draft', 'Active', 'Closed', 'Archived').optional(),
    experienceLevel: Joi.string()
      .valid('Entry Level', 'Mid Level', 'Senior Level', 'Executive')
      .optional(),
    createdBy: Joi.string().custom(objectId).optional(),
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

export {
  createJob,
  getJobs,
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
};
