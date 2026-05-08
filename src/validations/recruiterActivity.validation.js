import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getActivityLogs = {
  query: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).optional(),
    activityType: Joi.string()
      .valid(
        'job_posting_created',
        'candidate_screened',
        'interview_scheduled',
        'note_added',
        'feedback_added',
        'offer_sent',
        'offer_accepted',
        'offer_rejected'
      )
      .optional(),
    startDate: Joi.date().optional(),
    endDate: Joi.date().optional(),
    jobId: Joi.string().custom(objectId).optional(),
    candidateId: Joi.string().custom(objectId).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getActivityLogsSummary = {
  query: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).optional(),
    startDate: Joi.date().optional(),
    endDate: Joi.date().optional(),
  }),
};

const getActivityStatistics = {
  query: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).optional(),
    startDate: Joi.date().optional(),
    endDate: Joi.date().optional(),
  }),
};

export {
  getActivityLogs,
  getActivityLogsSummary,
  getActivityStatistics,
};
