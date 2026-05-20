import Joi from 'joi';

const getFeatureFlag = {
  params: Joi.object()
    .keys({
      key: Joi.string().trim().min(1).max(64).pattern(/^[a-z0-9-]+$/).required(),
    })
    .required(),
};

export { getFeatureFlag };
