import Joi from 'joi';

const objectId = Joi.string().custom((value, helpers) => {
  if (!value || !/^[a-fA-F0-9]{24}$/.test(value)) {
    return helpers.error('any.invalid');
  }
  return value;
}, 'objectId');

const listPricing = {
  query: Joi.object().keys({
    includeInactive: Joi.boolean().truthy('true').falsy('false'),
  }),
};

const upsertPricing = {
  body: Joi.object()
    .keys({
      countryIso: Joi.alternatives()
        .try(Joi.string().valid('*'), Joi.string().length(2).uppercase())
        .required(),
      numberType: Joi.string().valid('local', 'mobile', 'tollfree', '*').required(),
      monthlyPriceUsd: Joi.number().min(0).required(),
      currency: Joi.string().trim().uppercase().default('USD'),
      isActive: Joi.boolean(),
    })
    .required(),
};

const deletePricing = {
  params: Joi.object().keys({
    id: objectId.required(),
  }),
};

export { listPricing, upsertPricing, deletePricing };
