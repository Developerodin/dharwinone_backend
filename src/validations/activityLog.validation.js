import Joi from 'joi';
import { objectId } from './custom.validation.js';

const SORT_FIELD_ORDER = /^(createdAt|action|entityType):(asc|desc)$/i;

const getActivityLogs = {
  query: Joi.object().keys({
    actor: Joi.string().custom(objectId),
    action: Joi.string(),
    entityType: Joi.string(),
    entityId: Joi.string(),
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    includeAttendance: Joi.alternatives()
      .try(Joi.boolean(), Joi.string().valid('true', 'false'))
      .optional(),
    sortBy: Joi.string()
      .custom((value, helpers) => {
        if (!value) return value;
        const parts = value.split(',').map((p) => p.trim());
        for (const p of parts) {
          if (!SORT_FIELD_ORDER.test(p)) {
            return helpers.error('any.invalid');
          }
        }
        return value;
      })
      .messages({ 'any.invalid': 'sortBy must be like createdAt:desc (optional comma-separated list)' }),
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

export { getActivityLogs };
