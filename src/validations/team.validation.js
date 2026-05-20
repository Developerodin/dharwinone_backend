import Joi from 'joi';
import { objectId } from './custom.validation.js';

const ASSIGNMENT_MODES = ['manual', 'excel-import', 'position-auto', 'ai-suggested'];

const createTeamMember = {
  body: Joi.object()
    .keys({
      teamId: Joi.string().custom(objectId).required(),
      employeeId: Joi.string().custom(objectId).optional(),
      legacyName: Joi.string().trim().max(120).when('employeeId', {
        is: Joi.exist(),
        then: Joi.forbidden(),
        otherwise: Joi.required(),
      }),
      legacyEmail: Joi.string().email().lowercase().when('employeeId', {
        is: Joi.exist(),
        then: Joi.forbidden(),
        otherwise: Joi.required(),
      }),
      seniority: Joi.string().trim().max(80).optional(),
      assignmentMode: Joi.string().valid(...ASSIGNMENT_MODES).default('manual'),
      isStarred: Joi.boolean().optional(),
    })
    .required(),
};

const getTeamMembers = {
  query: Joi.object().keys({
    teamId: Joi.string().custom(objectId).optional(),
    includeInactive: Joi.boolean().default(false),
    search: Joi.string().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(200).optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getTeamMember = {
  params: Joi.object()
    .keys({
      teamMemberId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

const updateTeamMember = {
  params: Joi.object().keys({ teamMemberId: Joi.string().custom(objectId).required() }).required(),
  body: Joi.object()
    .keys({
      seniority: Joi.string().trim().max(80).optional(),
      assignmentMode: Joi.string().valid(...ASSIGNMENT_MODES).optional(),
      isStarred: Joi.boolean().optional(),
      isActive: Joi.boolean().optional(),
    })
    .min(1),
};

const deleteTeamMember = {
  params: Joi.object()
    .keys({
      teamMemberId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

const linkOrphan = {
  params: Joi.object().keys({ teamMemberId: Joi.string().custom(objectId).required() }).required(),
  body: Joi.object().keys({ employeeId: Joi.string().custom(objectId).required() }).required(),
};

const softRemoveTeamMember = {
  params: Joi.object().keys({ teamMemberId: Joi.string().custom(objectId).required() }).required(),
  body: Joi.object().keys({ removedReason: Joi.string().trim().max(500).required() }).required(),
};

const moveTeamMember = {
  params: Joi.object().keys({ teamMemberId: Joi.string().custom(objectId).required() }).required(),
  body: Joi.object().keys({ teamId: Joi.string().custom(objectId).required() }).required(),
};

const importTeams = { body: Joi.object({}) }; // file handled by multer

const exportTeams = {
  query: Joi.object({
    teamId: Joi.string().custom(objectId),
    department: Joi.string().trim(),
    includeInactive: Joi.boolean(),
  }),
};

const listImportLogs = {
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(10),
    sortBy: Joi.string().valid('-createdAt', 'createdAt'),
  }),
};

export {
  createTeamMember,
  getTeamMembers,
  getTeamMember,
  updateTeamMember,
  deleteTeamMember,
  linkOrphan,
  softRemoveTeamMember,
  moveTeamMember,
  importTeams,
  exportTeams,
  listImportLogs,
};
