import Joi from 'joi';

const registerToken = {
  body: Joi.object().keys({
    token: Joi.string().trim().required(),
    platform: Joi.string().valid('ios', 'android', 'web').optional(),
    deviceName: Joi.string().trim().max(200).allow('', null).optional(),
    soundEnabled: Joi.boolean().optional(),
    vibrationEnabled: Joi.boolean().optional(),
    notificationsEnabled: Joi.boolean().optional(),
  }),
};

const unregisterToken = {
  body: Joi.object().keys({
    token: Joi.string().trim().required(),
  }),
};

const updatePreferences = {
  body: Joi.object()
    .keys({
      soundEnabled: Joi.boolean().optional(),
      vibrationEnabled: Joi.boolean().optional(),
      notificationsEnabled: Joi.boolean().optional(),
      /** When set, only this device token is updated (preferred). */
      token: Joi.string().trim().optional(),
    })
    .or('soundEnabled', 'vibrationEnabled', 'notificationsEnabled'),
};

export { registerToken, unregisterToken, updatePreferences };
