import Joi from 'joi';
import { objectId } from './custom.validation.js';

const STATUS_VALUES = ['Applied', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'];

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
      status: Joi.string()
        .valid(...STATUS_VALUES)
        .optional()
        .messages({
          'any.only': `Status must be one of: ${STATUS_VALUES.join(', ')}`,
        }),
      notes: Joi.string().trim().optional().allow('', null),
    })
    .min(1)
    .messages({
      'object.min': 'At least one of status or notes is required',
    }),
};

const getJobApplications = {
  query: Joi.object().keys({
    jobId: Joi.string().custom(objectId).optional(),
    candidateId: Joi.string().custom(objectId).optional(),
    status: Joi.string()
      .valid(...STATUS_VALUES)
      .optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

export { getJobApplication, updateJobApplicationStatus, getJobApplications };
