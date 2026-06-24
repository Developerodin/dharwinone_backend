import Joi from 'joi';

const registerToken = {
  body: Joi.object().keys({
    token: Joi.string().trim().required(),
    platform: Joi.string().valid('ios', 'android', 'web').optional(),
    deviceName: Joi.string().trim().max(200).allow('', null).optional(),
  }),
};

const unregisterToken = {
  body: Joi.object().keys({
    token: Joi.string().trim().required(),
  }),
};

export { registerToken, unregisterToken };
