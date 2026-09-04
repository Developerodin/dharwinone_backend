import Joi from 'joi';
import { objectId } from './custom.validation.js';

const timeFormat = (value, helpers) => {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
    return helpers.message('Time must be in HH:mm format (24-hour)');
  }
  return value;
};

const shiftSchema = Joi.object()
  .keys({
    name: Joi.string().required().trim().min(1).max(200),
    description: Joi.string().optional().trim().max(1000).allow('', null),
    timezone: Joi.string().required().trim(),
    startTime: Joi.string().required().custom(timeFormat),
    endTime: Joi.string().required().custom(timeFormat),
    isActive: Joi.boolean().optional().default(true),
  })
  .custom((value, helpers) => {
    const { startTime, endTime } = value;
    if (startTime && endTime) {
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      if (eh * 60 + em === sh * 60 + sm) {
        return helpers.error('any.custom', { message: 'End time cannot be the same as start time' });
      }
    }
    return value;
  });

const createShift = {
  body: Joi.alternatives().try(
    shiftSchema,
    Joi.array().items(shiftSchema).min(1).max(100)
  ),
};

const updateShift = {
  params: Joi.object().keys({
    shiftId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim().min(1).max(200),
      description: Joi.string().optional().trim().max(1000).allow(null, ''),
      timezone: Joi.string().optional().trim(),
      startTime: Joi.string().optional().custom(timeFormat),
      endTime: Joi.string().optional().custom(timeFormat),
      isActive: Joi.boolean().optional(),
    })
    .min(1),
};

const getShift = {
  params: Joi.object().keys({
    shiftId: Joi.string().custom(objectId).required(),
  }),
};

const getShifts = {
  query: Joi.object().keys({
    name: Joi.string().optional().trim(),
    timezone: Joi.string().optional().trim(),
    isActive: Joi.boolean().optional(),
    sortBy: Joi.string()
      .valid('name:asc', 'name:desc', 'createdAt:asc', 'createdAt:desc')
      .optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const deleteShift = {
  params: Joi.object().keys({
    shiftId: Joi.string().custom(objectId).required(),
  }),
};

const listShiftAssignees = {
  params: Joi.object().keys({
    shiftId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    search: Joi.string().trim().allow('').max(120).optional(),
  }),
};

export { createShift, updateShift, getShift, getShifts, deleteShift, listShiftAssignees };
