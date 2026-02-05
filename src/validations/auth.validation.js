import Joi from 'joi';
import { password, objectId } from './custom.validation.js';

const register = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    isEmailVerified: Joi.boolean().optional(),
    roleIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
  }),
};

const login = {
  body: Joi.object().keys({
    email: Joi.string().required(),
    password: Joi.string().required(),
  }),
};

const logout = {
  body: Joi.object()
    .keys({
      refreshToken: Joi.string().optional(),
    })
    .default({}),
};

const refreshTokens = {
  body: Joi.object()
    .keys({
      refreshToken: Joi.string().optional(),
    })
    .default({}),
};

const forgotPassword = {
  body: Joi.object().keys({
    email: Joi.string().email().required(),
  }),
};

const resetPassword = {
  query: Joi.object().keys({
    token: Joi.string().required(),
  }),
  body: Joi.object().keys({
    password: Joi.string().required().custom(password),
  }),
};

const changePassword = {
  body: Joi.object().keys({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().required().custom(password),
  }),
};

const verifyEmail = {
  query: Joi.object().keys({
    token: Joi.string().required(),
  }),
};

const impersonate = {
  body: Joi.object().keys({
    userId: Joi.string().required().custom(objectId),
  }),
};

export { register, login, logout, refreshTokens, forgotPassword, resetPassword, changePassword, verifyEmail, impersonate };

