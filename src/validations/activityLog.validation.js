import Joi from 'joi';
import { objectId } from './custom.validation.js';

const SORT_FIELD_ORDER = /^(createdAt|action|entityType):(asc|desc)$/i;

const IP_FILTER_PATTERN = /^[0-9a-fA-F:.]+$/;

/** Shared filters for GET list and GET export (no pagination). */
const activityLogFilterQuery = {
  actor: Joi.string().custom(objectId),
  action: Joi.string(),
  entityType: Joi.string(),
  entityId: Joi.string(),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  includeAttendance: Joi.alternatives()
    .try(Joi.boolean(), Joi.string().valid('true', 'false'))
    .optional(),
  ip: Joi.alternatives()
    .try(
      Joi.string().valid(''),
      Joi.string().trim().max(45).pattern(IP_FILTER_PATTERN)
    )
    .optional(),
  q: Joi.string().trim().max(200).optional().allow(''),
};

const getActivityLogs = {
  query: Joi.object().keys({
    ...activityLogFilterQuery,
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

const exportActivityLogs = {
  query: Joi.object()
    .keys({
      ...activityLogFilterQuery,
      source: Joi.forbidden(),
      page: Joi.forbidden(),
      limit: Joi.forbidden(),
      sortBy: Joi.forbidden(),
    })
    .unknown(false),
};

export { getActivityLogs, exportActivityLogs };
