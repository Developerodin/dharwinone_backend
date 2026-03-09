import Joi from 'joi';

const listUnifiedCalls = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
    source: Joi.string().valid('all', 'telephony', 'in_app').default('all'),
    search: Joi.string().trim().allow(''),
    status: Joi.string().trim().allow(''),
    purpose: Joi.string().trim().allow(''),
    language: Joi.string().trim().allow(''),
    sortBy: Joi.string().valid('date', 'createdAt').default('createdAt'),
    order: Joi.string().valid('asc', 'desc').default('desc'),
  }),
};

export { listUnifiedCalls };
