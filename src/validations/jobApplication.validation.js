import Joi from 'joi';
import { objectId, boundedLimit } from './custom.validation.js';
import { APPLICATION_STATUSES } from '../constants/atsPipeline.js';

const STATUS_VALUES = APPLICATION_STATUSES;

/**
 * Multi-status list, e.g. "Applied,Screening". Single values still validate; service
 * splits via parseStringList in applicantQuery.service.js.
 */
const commaSeparatedApplicationStatuses = Joi.string().custom((value, helpers) => {
  const parts = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!STATUS_VALUES.includes(part)) return helpers.error('any.invalid');
  }
  return value;
}, 'comma-separated application statuses');

const statusListQuery = Joi.alternatives().try(
  Joi.array().items(Joi.string().valid(...STATUS_VALUES)),
  Joi.string().valid(...STATUS_VALUES),
  commaSeparatedApplicationStatuses
);

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
    status: statusListQuery.optional(),
    statuses: statusListQuery.optional(),
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
    /** When true, return only schedule-eligible applications; requires jobId or candidateId unless distinctCandidates is true. */
    scheduleEligible: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
      .optional(),
    /** When true with scheduleEligible, return one application per distinct candidate (no jobId/candidateId required). */
    distinctCandidates: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
      .optional(),
    sortBy: Joi.string().optional(),
    limit: boundedLimit(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }).custom((value, helpers) => {
    const scheduleEligible =
      value.scheduleEligible === true ||
      value.scheduleEligible === 'true' ||
      value.scheduleEligible === 1 ||
      value.scheduleEligible === '1';
    const distinctCandidates =
      value.distinctCandidates === true ||
      value.distinctCandidates === 'true' ||
      value.distinctCandidates === 1 ||
      value.distinctCandidates === '1';
    if (scheduleEligible && !value.jobId && !value.candidateId && !distinctCandidates) {
      return helpers.message({
        custom: 'jobId or candidateId is required when scheduleEligible is true',
      });
    }
    if (distinctCandidates && !scheduleEligible) {
      return helpers.message({
        custom: 'scheduleEligible is required when distinctCandidates is true',
      });
    }
    return value;
  }),
};

const getMyApplications = {
  query: Joi.object().keys({
    status: Joi.string()
      .valid(...STATUS_VALUES)
      .optional(),
    sortBy: Joi.string().optional(),
    limit: boundedLimit(100).optional(),
    page: Joi.number().integer().min(1).optional(),
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
