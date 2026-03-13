import Joi from 'joi';
import { password, objectId } from './custom.validation.js';


const createUser = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    role: Joi.string().required().valid('user', 'recruiter', 'supervisor', 'admin', 'Administrator', 'agent', 'Candidate', 'Manager', 'Mentor', 'Student'),
    roleIds: Joi.array().items(Joi.string().custom(objectId)).default([]),
    status: Joi.string().valid('active', 'pending', 'disabled', 'deleted').default('active'),
  }),
};

const getUsers = {
  query: Joi.object().keys({
    name: Joi.string(),
    role: Joi.string(),
    status: Joi.string().valid('active', 'pending', 'disabled', 'deleted'),
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const notificationPreferencesSchema = Joi.object({
  leaveUpdates: Joi.boolean(),
  taskAssignments: Joi.boolean(),
  applicationUpdates: Joi.boolean(),
  offerUpdates: Joi.boolean(),
  meetingInvitations: Joi.boolean(),
  meetingReminders: Joi.boolean(),
  certificates: Joi.boolean(),
  courseUpdates: Joi.boolean(),
  recruiterUpdates: Joi.boolean(),
});

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
      profileSummary: Joi.string().trim().allow('', null),
      profilePicture: Joi.object({
        url: Joi.string().uri().optional(),
        key: Joi.string().optional().trim(),
        originalName: Joi.string().optional().trim(),
        size: Joi.number().optional().integer().min(0),
        mimeType: Joi.string().optional().trim(),
      }).optional().allow(null),
      notificationPreferences: notificationPreferencesSchema,
    })
    .min(1),
};

const deleteUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

export { createUser, getUsers, getUser, updateUser, deleteUser };

