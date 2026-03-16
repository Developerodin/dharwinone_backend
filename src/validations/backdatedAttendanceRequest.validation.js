import Joi from 'joi';
import { objectId } from './custom.validation.js';

// Accept Date, ISO string, or date+time string (e.g. "2025-03-13T09:30") so time inputs work when combined with date
const parseableDate = Joi.custom((value, helpers) => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return helpers.error('date.base');
  }
  return d;
}, 'parseable date').messages({
  'date.base': 'Must be a valid date or time',
});

const attendanceEntrySchema = Joi.object().keys({
  date: parseableDate.required().messages({
    'any.required': 'Date is required',
    'date.base': 'Date must be a valid date',
  }),
  punchIn: parseableDate.required().messages({
    'any.required': 'Punch in time is required',
    'date.base': 'Punch in must be a valid date or time',
  }),
  punchOut: parseableDate.required().messages({
    'any.required': 'Punch out time is required',
    'date.base': 'Punch out must be a valid date or time',
  }),
  timezone: Joi.string().optional().trim().messages({
    'string.empty': 'Timezone cannot be empty',
  }),
});

const createBackdatedAttendanceRequest = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    attendanceEntries: Joi.array()
      .items(attendanceEntrySchema)
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one attendance entry is required',
        'any.required': 'Attendance entries are required',
      }),
    notes: Joi.string().optional().trim().max(1000).allow(null, '').messages({
      'string.max': 'Notes must not exceed 1000 characters',
    }),
  }),
};

const getBackdatedAttendanceRequests = {
  query: Joi.object().keys({
    student: Joi.string().custom(objectId).optional(),
    status: Joi.string().valid('pending', 'approved', 'rejected', 'cancelled').optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getBackdatedAttendanceRequest = {
  params: Joi.object().keys({
    requestId: Joi.string().custom(objectId).required(),
  }),
};

const getBackdatedAttendanceRequestsByStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    status: Joi.string().valid('pending', 'approved', 'rejected', 'cancelled').optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const approveBackdatedAttendanceRequest = {
  params: Joi.object().keys({
    requestId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    adminComment: Joi.string().optional().trim().max(1000).allow(null, '').messages({
      'string.max': 'Admin comment must not exceed 1000 characters',
    }),
  }),
};

const rejectBackdatedAttendanceRequest = {
  params: Joi.object().keys({
    requestId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    adminComment: Joi.string().optional().trim().max(1000).allow(null, '').messages({
      'string.max': 'Admin comment must not exceed 1000 characters',
    }),
  }),
};

const updateBackdatedAttendanceRequest = {
  params: Joi.object().keys({
    requestId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    attendanceEntries: Joi.array()
      .items(attendanceEntrySchema)
      .min(1)
      .optional()
      .messages({
        'array.min': 'At least one attendance entry is required',
      }),
    notes: Joi.string().optional().trim().max(1000).allow(null, '').messages({
      'string.max': 'Notes must not exceed 1000 characters',
    }),
  }).min(1).messages({
    'object.min': 'At least one field must be provided for update',
  }),
};

const cancelBackdatedAttendanceRequest = {
  params: Joi.object().keys({
    requestId: Joi.string().custom(objectId).required(),
  }),
};

const createBackdatedAttendanceRequestMe = {
  body: Joi.object().keys({
    attendanceEntries: Joi.array()
      .items(attendanceEntrySchema)
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one attendance entry is required',
        'any.required': 'Attendance entries are required',
      }),
    notes: Joi.string().optional().trim().max(1000).allow(null, '').messages({
      'string.max': 'Notes must not exceed 1000 characters',
    }),
  }),
};

const getBackdatedAttendanceRequestsByUserMe = {
  query: Joi.object().keys({
    status: Joi.string().valid('pending', 'approved', 'rejected', 'cancelled').optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

export {
  createBackdatedAttendanceRequest,
  createBackdatedAttendanceRequestMe,
  getBackdatedAttendanceRequests,
  getBackdatedAttendanceRequest,
  getBackdatedAttendanceRequestsByStudent,
  getBackdatedAttendanceRequestsByUserMe,
  approveBackdatedAttendanceRequest,
  rejectBackdatedAttendanceRequest,
  updateBackdatedAttendanceRequest,
  cancelBackdatedAttendanceRequest,
};
