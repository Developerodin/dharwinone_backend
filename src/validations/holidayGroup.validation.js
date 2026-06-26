import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createHolidayGroup = {
  body: Joi.object().keys({
    name: Joi.string().required().trim().min(1).max(120).messages({
      'any.required': 'Group name is required',
      'string.empty': 'Group name cannot be empty',
      'string.max': 'Group name must not exceed 120 characters',
    }),
    description: Joi.string().optional().allow('').trim().max(500),
    isActive: Joi.boolean().optional().default(true),
    memberIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
    holidayIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
  }),
};

const getHolidayGroups = {
  query: Joi.object().keys({
    name: Joi.string().optional().trim(),
    isActive: Joi.boolean().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getHolidayGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
};

const updateHolidayGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim().min(1).max(120),
      description: Joi.string().optional().allow('').trim().max(500),
      isActive: Joi.boolean().optional(),
      memberIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
      holidayIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
    })
    .min(1),
};

const deleteHolidayGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
};

const groupAction = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
};

export {
  createHolidayGroup,
  getHolidayGroups,
  getHolidayGroup,
  updateHolidayGroup,
  deleteHolidayGroup,
  groupAction,
};
