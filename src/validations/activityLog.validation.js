import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getActivityLogs = {
  query: Joi.object().keys({
    actor: Joi.string().custom(objectId),
    action: Joi.string(),
    entityType: Joi.string(),
    entityId: Joi.string(),
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

export { getActivityLogs };
