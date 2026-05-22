import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { APPLICATION_STATUSES } from '../constants/atsPipeline.js';

const STATUS_VALUES = APPLICATION_STATUSES;

const createJobApplication = {
  body: Joi.object()
    .keys({
      job: Joi.string().custom(objectId).required(),
      candidate: Joi.string().custom(objectId).required(),
      status: Joi.string()
        .valid(...STATUS_VALUES)
        .optional(),
      coverLetter: Joi.string().trim().optional().allow('', null),
      notes: Joi.string().trim().optional().allow('', null),
    })
    .min(2),
};

const getJobApplication = {
  params: Joi.object().keys({
    applicationId: Joi.string().custom(objectId).required(),
  }),
};

const updateJobApplicationStatus = {
  params: Joi.object().keys({
    applicationId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      job: Joi.string().custom(objectId).optional(),
      candidate: Joi.string().custom(objectId).optional(),
      status: Joi.string()
        .valid(...STATUS_VALUES)
        .optional()
        .messages({
          'any.only': `Status must be one of: ${STATUS_VALUES.join(', ')}`,
        }),
      coverLetter: Joi.string().trim().optional().allow('', null),
      notes: Joi.string().trim().optional().allow('', null),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field to update is required',
    }),
};

const deleteJobApplication = {
  params: Joi.object().keys({
    applicationId: Joi.string().custom(objectId).required(),
  }),
};

const getJobApplications = {
  query: Joi.object().keys({
    jobId: Joi.string().custom(objectId).optional(),
    candidateId: Joi.string().custom(objectId).optional(),
    recruiterId: Joi.string().custom(objectId).optional(),
    status: Joi.string()
      .valid(...STATUS_VALUES)
      .optional(),
    q: Joi.string().trim().allow('').optional(),
    department: Joi.string().trim().allow('').optional(),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().optional(),
    /** Only applications for jobs that exist with status Active (excludes closed/archived/deleted-job orphans). */
    activeJobsOnly: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
      .optional(),
    /** Hide synthetic offer-letter placeholder applications (no real applicant). */
    excludeInternal: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
      .optional(),
    /** Return all applications including duplicate (job, applicant) rows. */
    includeDuplicates: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
      .optional(),
    /** Emit one structured log line per row for applicant-email diagnostics. */
    debug: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
      .optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getMyApplications = {
  query: Joi.object().keys({
    status: Joi.string()
      .valid(...STATUS_VALUES)
      .optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const withdrawMyApplication = {
  params: Joi.object().keys({
    applicationId: Joi.string().custom(objectId).required(),
  }),
};

export {
  getJobApplication,
  updateJobApplicationStatus,
  getJobApplications,
  getMyApplications,
  withdrawMyApplication,
  createJobApplication,
  deleteJobApplication,
};
