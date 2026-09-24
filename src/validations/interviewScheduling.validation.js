import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { isValidTimeZone } from '../utils/zonedTime.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const ianaTz = Joi.string()
  .trim()
  .custom((value, helpers) => (isValidTimeZone(value) ? value : helpers.error('any.invalid')), 'IANA timezone');

const startBeforeEnd = (value, helpers) => (value.start < value.end ? value : helpers.error('any.invalid'));

const windowSchema = Joi.object({
  start: Joi.string().pattern(HHMM).required(),
  end: Joi.string().pattern(HHMM).required(),
})
  .custom(startBeforeEnd, 'start before end')
  .messages({ 'any.invalid': 'Window start must be before end' });

const weeklySchema = Joi.object({
  day: Joi.number().integer().min(0).max(6).required(),
  start: Joi.string().pattern(HHMM).required(),
  end: Joi.string().pattern(HHMM).required(),
})
  .custom(startBeforeEnd, 'start before end')
  .messages({ 'any.invalid': 'Window start must be before end' });

const availabilityBody = Joi.object({
  timezone: ianaTz.required(),
  bufferMinutes: Joi.number().integer().min(0).max(120).default(15),
  weekly: Joi.array().items(weeklySchema).max(50).default([]),
  overrides: Joi.array()
    .items(
      Joi.object({
        date: Joi.string()
          .pattern(/^\d{4}-\d{2}-\d{2}$/)
          .required(),
        blocked: Joi.boolean().default(false),
        windows: Joi.array().items(windowSchema).max(10).default([]),
      })
    )
    .max(200)
    .default([]),
}).required();

export const putMyAvailability = { body: availabilityBody };

export const getUserAvailability = {
  params: Joi.object({ userId: Joi.string().custom(objectId).required() }),
};

export const putUserAvailability = {
  params: Joi.object({ userId: Joi.string().custom(objectId).required() }),
  body: availabilityBody,
};

export const listHolds = {
  query: Joi.object({
    status: Joi.string().valid('held', 'approving', 'approved', 'rejected', 'expired', 'cancelled', 'all').default('held'),
    jobId: Joi.string().custom(objectId),
  }),
};

export const approveHold = {
  params: Joi.object({ id: Joi.string().custom(objectId).required() }),
};

export const rejectHold = {
  params: Joi.object({ id: Joi.string().custom(objectId).required() }),
  body: Joi.object({ reason: Joi.string().trim().max(500).allow('', null) }),
};

export const previewSlots = {
  query: Joi.object({
    applicationId: Joi.string().custom(objectId).required(),
    tz: ianaTz,
    limit: Joi.number().integer().min(1).max(50).default(12),
  }),
};
