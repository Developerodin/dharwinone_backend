import Joi from 'joi';
import { objectId } from './custom.validation.js';

const studentIdParam = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
};

const punchIn = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    punchInTime: Joi.date().iso(),
    notes: Joi.string().allow(''),
    timezone: Joi.string().trim(),
  }),
};

const punchOut = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    punchOutTime: Joi.date().iso(),
    notes: Joi.string().allow(''),
  }),
};

const punchInMe = {
  body: Joi.object().keys({
    punchInTime: Joi.date().iso(),
    notes: Joi.string().allow(''),
    timezone: Joi.string().trim(),
  }),
};

const punchOutMe = {
  body: Joi.object().keys({
    punchOutTime: Joi.date().iso(),
    notes: Joi.string().allow(''),
  }),
};

const listAttendanceMe = {
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    limit: Joi.number().integer().min(1).max(500),
    page: Joi.number().integer().min(1),
  }),
};

const getStatisticsMe = {
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
  }),
};

const listAttendance = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    limit: Joi.number().integer().min(1).max(500),
    page: Joi.number().integer().min(1),
  }),
};

/** List attendance stored on User (agent / user-based punch), not Student */
const listAttendanceUser = {
  params: Joi.object().keys({
    userId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    limit: Joi.number().integer().min(1).max(500),
    page: Joi.number().integer().min(1),
  }),
};

/** List attendance by ATS candidate id (resolves Student vs User attendance server-side) */
const listAttendanceCandidate = {
  params: Joi.object().keys({
    candidateId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    limit: Joi.number().integer().min(1).max(500),
    page: Joi.number().integer().min(1),
  }),
};

const getStatistics = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
  }),
};

const trackList = {
  query: Joi.object().keys({
    search: Joi.string().trim().allow('').optional(),
  }),
};

const trackHistory = {
  query: Joi.object().keys({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso(),
    limit: Joi.number().integer().min(1).max(1000),
    search: Joi.string().trim().allow('').optional(),
  }),
};

const addHolidaysToStudents = {
  body: Joi.object().keys({
    studentIds: Joi.array()
      .items(Joi.string().custom(objectId))
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one student ID is required',
        'any.required': 'Student IDs are required',
      }),
    holidayIds: Joi.array()
      .items(Joi.string().custom(objectId))
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one holiday ID is required',
        'any.required': 'Holiday IDs are required',
      }),
  }),
};

const removeHolidaysFromStudents = {
  body: Joi.object().keys({
    studentIds: Joi.array()
      .items(Joi.string().custom(objectId))
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one student ID is required',
        'any.required': 'Student IDs are required',
      }),
    holidayIds: Joi.array()
      .items(Joi.string().custom(objectId))
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one holiday ID is required',
        'any.required': 'Holiday IDs are required',
      }),
  }),
};

const assignLeavesToStudents = {
  body: Joi.object().keys({
    studentIds: Joi.array()
      .items(Joi.string().custom(objectId))
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one student ID is required',
        'any.required': 'Student IDs are required',
      }),
    dates: Joi.array()
      .items(Joi.alternatives().try(Joi.date(), Joi.date().iso(), Joi.string().trim()))
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one date is required',
        'any.required': 'Dates are required',
      }),
    leaveType: Joi.string().valid('casual', 'sick', 'unpaid').required().messages({
      'any.required': 'Leave type is required',
    }),
    notes: Joi.string().allow('').optional(),
  }),
};

const regularizeEntrySchema = Joi.object().keys({
  date: Joi.date().iso().required(),
  punchIn: Joi.date().iso().required(),
  punchOut: Joi.date().iso().optional().allow(null),
  timezone: Joi.string().trim().optional(),
  notes: Joi.string().allow('').optional(),
});

const regularizeAttendance = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    attendanceEntries: Joi.array()
      .items(regularizeEntrySchema)
      .min(1)
      .required()
      .messages({
        'array.min': 'At least one attendance entry is required',
        'any.required': 'Attendance entries are required',
      }),
  }),
};

export {
  studentIdParam,
  punchIn,
  punchOut,
  listAttendance,
  listAttendanceUser,
  listAttendanceCandidate,
  getStatistics,
  punchInMe,
  punchOutMe,
  listAttendanceMe,
  getStatisticsMe,
  trackList,
  trackHistory,
  addHolidaysToStudents,
  removeHolidaysFromStudents,
  assignLeavesToStudents,
  regularizeAttendance,
};
