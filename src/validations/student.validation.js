import Joi from 'joi';
import { objectId } from './custom.validation.js';

const stringListQuery = Joi.alternatives().try(
  Joi.array().items(Joi.string().trim().min(1)),
  Joi.string().trim().min(1)
);

const getStudents = {
  query: Joi.object().keys({
    status: Joi.string().valid('active', 'inactive', 'all'),
    position: Joi.string().custom(objectId).optional(),
    search: Joi.string().allow('').optional(),
    names: stringListQuery.optional(),
    skills: stringListQuery.optional(),
    education: stringListQuery.optional(),
    email: Joi.string().allow('').optional(),
    experienceMin: Joi.number().integer().min(0).optional(),
    experienceMax: Joi.number().integer().min(0).optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    /** When true, only users with the Employee RBAC role (excludes agents, candidates, attendance-only profiles). */
    employeeRoleOnly: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
    /** When true, only users with the Student RBAC role (Training students list). */
    studentRoleOnly: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
    /** When true, exclude owners linked to a resigned/inactive employee record. */
    excludeResignedEmployed: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
  }),
};

const getStudentFilterOptions = {
  query: Joi.object().keys({
    status: Joi.string().valid('active', 'inactive', 'all'),
    position: Joi.string().custom(objectId).optional(),
    search: Joi.string().allow('').optional(),
    employeeRoleOnly: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
    studentRoleOnly: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
    excludeResignedEmployed: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
  }),
};

const getStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId),
  }),
};

const updateStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      phone: Joi.string().optional().allow('', null),
      dateOfBirth: Joi.date().optional().allow(null),
      gender: Joi.string().valid('male', 'female', 'other').optional().allow(null),
      address: Joi.object({
        street: Joi.string().optional().allow('', null),
        city: Joi.string().optional().allow('', null),
        state: Joi.string().optional().allow('', null),
        zipCode: Joi.string().optional().allow('', null),
        country: Joi.string().optional().allow('', null),
      }).optional(),
      education: Joi.array().items(
        Joi.object({
          degree: Joi.string().optional().allow('', null),
          institution: Joi.string().optional().allow('', null),
          fieldOfStudy: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      ).optional(),
      experience: Joi.array().items(
        Joi.object({
          title: Joi.string().optional().allow('', null),
          company: Joi.string().optional().allow('', null),
          location: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      ).optional(),
      skills: Joi.array().items(Joi.string()).optional(),
      documents: Joi.array().items(
        Joi.object({
          name: Joi.string().required(),
          type: Joi.string().required(),
          fileUrl: Joi.string().optional().allow('', null),
          fileKey: Joi.string().optional().allow('', null),
        })
      ).optional(),
      bio: Joi.string().optional().allow('', null),
      profileImageUrl: Joi.string().optional().allow('', null),
      status: Joi.string().valid('active', 'inactive').optional(),
      position: Joi.string().custom(objectId).optional().allow(null),
    })
    .min(1),
};

const deleteStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId),
  }),
};

const createStudentFromUser = {
  body: Joi.object().keys({
    userId: Joi.string().required().custom(objectId),
    /** When true: if user owns a Candidate but lacks Student role, add Student role then create profile (students.manage only). */
    ensureStudentRoleForCandidateOwner: Joi.boolean().optional(),
  }),
};

const VALID_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const updateWeekOff = {
  body: Joi.object().keys({
    studentIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required().messages({
      'array.min': 'At least one student ID is required',
      'any.required': 'Student IDs are required',
    }),
    weekOff: Joi.array()
      .items(Joi.string().valid(...VALID_DAYS))
      .unique()
      .required()
      .messages({
        'any.required': 'Week-off days are required',
        'array.unique': 'Week-off days must be unique',
      }),
  }),
};

const importWeekOff = {
  body: Joi.object()
    .keys({
      entries: Joi.array()
        .items(
          Joi.object()
            .keys({
              email: Joi.string().email().required().messages({ 'any.required': 'Email is required' }),
              weekOff: Joi.array()
                .items(Joi.string().valid(...VALID_DAYS))
                .unique()
                .optional()
                .default([]),
              notes: Joi.string().optional().allow('', null),
            })
            .required()
        )
        .min(1)
        .max(1000)
        .required()
        .messages({ 'array.min': 'At least one entry is required' }),
    })
    .required(),
};

const getWeekOff = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId).required(),
  }),
};

const exportWeekOff = {
  query: Joi.object().keys({
    days: Joi.string()
      .trim()
      .required()
      .custom((value, helpers) => {
        const parsed = value
          .split(',')
          .map((day) => day.trim())
          .filter(Boolean);
        if (!parsed.length) {
          return helpers.error('any.invalid');
        }
        const invalid = parsed.filter((day) => !VALID_DAYS.includes(day));
        if (invalid.length) {
          return helpers.message(`Invalid week-off day(s): ${invalid.join(', ')}`);
        }
        return value;
      })
      .messages({
        'any.required': 'At least one week-off day is required',
        'any.invalid': 'At least one week-off day is required',
      }),
  }),
};

const listWeekOffAssignments = {
  query: Joi.object().keys({
    day: Joi.string()
      .valid(...VALID_DAYS)
      .required()
      .messages({
        'any.required': 'Week-off day is required',
        'any.only': 'Week-off day must be a valid weekday',
      }),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    search: Joi.string().trim().allow('').max(120).optional(),
  }),
};

const listWeekOffDayCounts = {
  query: Joi.object().keys({}),
};

const unassignWeekOffDay = {
  body: Joi.object()
    .keys({
      day: Joi.string()
        .valid(...VALID_DAYS)
        .required()
        .messages({
          'any.required': 'Week-off day is required',
          'any.only': 'Week-off day must be a valid weekday',
        }),
      studentId: Joi.string().custom(objectId).optional(),
      candidateId: Joi.string().custom(objectId).optional(),
    })
    .or('studentId', 'candidateId')
    .messages({
      'object.missing': 'A student or employee is required',
    }),
};

const assignShift = {
  body: Joi.object().keys({
    studentIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required().messages({
      'array.min': 'At least one student ID is required',
      'any.required': 'Student IDs are required',
    }),
    shiftId: Joi.string().custom(objectId).required().messages({
      'any.required': 'Shift ID is required',
    }),
  }),
};

export { getStudents, getStudentFilterOptions, getStudent, updateStudent, deleteStudent, createStudentFromUser, updateWeekOff, importWeekOff, getWeekOff, exportWeekOff, listWeekOffAssignments, listWeekOffDayCounts, unassignWeekOffDay, assignShift };
