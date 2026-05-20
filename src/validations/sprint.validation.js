import Joi from 'joi';
import { objectId } from './custom.validation.js';

const SPRINT_STATUSES = ['planning', 'active', 'completed'];

const createSprint = {
  body: Joi.object()
    .keys({
      name: Joi.string().required().trim().messages({
        'any.required': 'Sprint name is required',
        'string.empty': 'Sprint name cannot be empty',
      }),
      projectId: Joi.string().custom(objectId).required(),
      goal: Joi.string().optional().trim().allow('', null),
      startDate: Joi.date().optional().allow(null),
      endDate: Joi.date().optional().allow(null),
      status: Joi.string()
        .valid(...SPRINT_STATUSES)
        .optional()
        .default('planning'),
    })
    .required(),
};

const getSprints = {
  query: Joi.object().keys({
    projectId: Joi.string().custom(objectId).optional(),
    status: Joi.string().valid(...SPRINT_STATUSES).optional(),
    search: Joi.string().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(200).optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getSprint = {
  params: Joi.object()
    .keys({
      sprintId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

const updateSprint = {
  params: Joi.object()
    .keys({
      sprintId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim(),
      projectId: Joi.string().custom(objectId).optional(),
      goal: Joi.string().optional().trim().allow('', null),
      startDate: Joi.date().optional().allow(null),
      endDate: Joi.date().optional().allow(null),
      status: Joi.string().valid(...SPRINT_STATUSES).optional(),
    })
    .min(1),
};

const deleteSprint = {
  params: Joi.object()
    .keys({
      sprintId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

export { createSprint, getSprints, getSprint, updateSprint, deleteSprint };
