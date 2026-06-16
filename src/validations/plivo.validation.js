import Joi from 'joi';

const searchAvailableNumbers = {
  query: Joi.object().keys({
    countryIso: Joi.string().length(2).uppercase().required(),
    type: Joi.string()
      .valid('local', 'tollfree', 'mobile', 'national', 'fixed')
      .default('local'),
    pattern: Joi.string().trim().allow(''),
    services: Joi.string().trim().allow(''),
    /** City name — local numbers only. */
    city: Joi.string().trim().allow(''),
    /** Region name (e.g. Frankfurt) — fixed numbers only. */
    region: Joi.string().trim().allow(''),
    limit: Joi.number().integer().min(1).max(20),
    /** Pagination offset (page * limit). */
    offset: Joi.number().integer().min(0),
  }),
};

const buyNumber = {
  body: Joi.object()
    .keys({
      number: Joi.string().trim().required(),
    })
    .required(),
};

const listOwnedNumbers = {
  query: Joi.object().keys({
    type: Joi.string().valid('local', 'tollfree', 'mobile', 'national', 'fixed'),
    alias: Joi.string().trim().allow(''),
    limit: Joi.number().integer().min(1).max(20),
    offset: Joi.number().integer().min(0),
  }),
};

export { searchAvailableNumbers, buyNumber, listOwnedNumbers };
