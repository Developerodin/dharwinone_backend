import Joi from 'joi';

const getSignalingToken = {
  body: Joi.object().keys({}).default({}),
};

const createDeviceToken = {
  body: Joi.object().keys({
    deviceId: Joi.string().required().trim().min(1).max(128),
    label: Joi.string().optional().allow('').max(256),
    expirationDays: Joi.number().integer().min(1).max(3650).default(365),
  }),
};

const revokeDeviceToken = {
  body: Joi.object().keys({
    jti: Joi.string().required().trim().uuid(),
  }),
};

const listDeviceTokens = {
  query: Joi.object().keys({
    deviceId: Joi.string().optional().trim(),
  }),
};

export { getSignalingToken, createDeviceToken, revokeDeviceToken, listDeviceTokens };
