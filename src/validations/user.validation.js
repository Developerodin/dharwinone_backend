import Joi from 'joi';
import { password, objectId, notificationPreferencesSchema } from './custom.validation.js';

const stringListQuery = Joi.alternatives().try(
  Joi.array().items(Joi.string().trim().min(1)),
  Joi.string().trim().min(1)
);

const createUser = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    roleIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
    status: Joi.string().valid('active', 'pending', 'disabled', 'deleted').default('active'),
  }),
};

const getUsers = {
  query: Joi.object().keys({
    name: Joi.string(),
    status: Joi.string().valid('active', 'pending', 'disabled', 'deleted'),
    search: Joi.string().allow('').optional(),
    /** Filter by app role name (e.g. recruiter, sales_agent for pickers). */
    role: Joi.string().valid('recruiter', 'referral_eligible', 'sales_agent').optional(),
    names: stringListQuery.optional(),
    domains: stringListQuery.optional(),
    education: stringListQuery.optional(),
    locations: stringListQuery.optional(),
    email: Joi.string().allow('').optional(),
    sortBy: Joi.string().regex(/^(name|email|education|location|createdAt):(asc|desc)$/),
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

const getUserFilterOptions = {
  query: Joi.object().keys({
    role: Joi.string().valid('recruiter').required(),
    search: Joi.string().allow('').optional(),
  }),
};

const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const updateUser = {
  params: Joi.object().keys({
    userId: Joi.required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      email: Joi.string().email(),
      username: Joi.string().trim().lowercase().allow('', null),
      password: Joi.string().custom(password),
      name: Joi.string(),
      roleIds: Joi.array().items(Joi.string().custom(objectId)),
      status: Joi.string().valid('active', 'pending', 'disabled', 'deleted'),
      phoneNumber: Joi.string().trim().allow('', null),
      countryCode: Joi.string().trim().allow('', null),
      education: Joi.string().trim().allow('', null),
      domain: Joi.array().items(Joi.string().trim()).allow(null),
      location: Joi.string().trim().allow('', null),
      profileSummary: Joi.string().trim().max(4000).allow('', null),
      profilePicture: Joi.object({
        url: Joi.string().uri().optional(),
        key: Joi.string().optional().trim(),
        originalName: Joi.string().optional().trim(),
        size: Joi.number().optional().integer().min(0),
        mimeType: Joi.string().optional().trim(),
      }).optional().allow(null),
      notificationPreferences: notificationPreferencesSchema,
      hrmDeviceId: Joi.string().trim().max(256).allow('', null),
    })
    .min(1),
};

const deleteUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const getPublicRecruiter = {
  params: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).required(),
  }),
};

export { createUser, getUsers, getUserFilterOptions, getUser, updateUser, deleteUser, getPublicRecruiter };

