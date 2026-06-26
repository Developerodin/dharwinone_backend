import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createHoliday = {
  body: Joi.object().keys({
    title: Joi.string().required().trim().min(1).max(200).messages({
      'any.required': 'Holiday title is required',
      'string.empty': 'Holiday title cannot be empty',
      'string.max': 'Holiday title must not exceed 200 characters',
    }),
    date: Joi.date().required().messages({
      'any.required': 'Holiday date is required',
      'date.base': 'Holiday date must be a valid date',
    }),
    endDate: Joi.date().optional().allow(null).messages({
      'date.base': 'End date must be a valid date',
    }),
    isActive: Joi.boolean().optional().default(true),
    group: Joi.string().optional().allow('').trim().max(120),
  }),
};

const updateHoliday = {
  params: Joi.object().keys({
    holidayId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    title: Joi.string().optional().trim().min(1).max(200),
    date: Joi.date().optional(),
    endDate: Joi.date().optional().allow(null),
    isActive: Joi.boolean().optional(),
    group: Joi.string().optional().allow('').trim().max(120),
  }),
};

const getHoliday = {
  params: Joi.object().keys({
    holidayId: Joi.string().custom(objectId).required(),
  }),
};

const getHolidays = {
  query: Joi.object().keys({
    title: Joi.string().optional().trim(),
    group: Joi.string().optional().trim(),
    date: Joi.date().optional(),
    startDate: Joi.date().optional(),
    endDate: Joi.date().optional(),
    isActive: Joi.boolean().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const deleteHoliday = {
  params: Joi.object().keys({
    holidayId: Joi.string().custom(objectId).required(),
  }),
};

export {
  createHoliday,
  updateHoliday,
  getHoliday,
  getHolidays,
  deleteHoliday,
};
