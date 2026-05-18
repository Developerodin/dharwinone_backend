import Joi from 'joi';
import { objectId } from './custom.validation.js';

const TEAM_GROUPS = ['team_ui', 'team_react', 'team_testing'];

const createTeamMember = {
  body: Joi.object().keys({
    employeeId:     Joi.string().custom(objectId).required(),
    teamId:         Joi.string().custom(objectId).required(),
    seniority:      Joi.string().trim().default('Member'),
    assignmentMode: Joi.string().valid('manual', 'excel-import', 'position-auto', 'ai-suggested').default('manual'),
    isStarred:      Joi.boolean(),
  }),
};

const getTeamMembers = {
  query: Joi.object().keys({
    teamGroup: Joi.string().valid(...TEAM_GROUPS).optional(),
    teamId: Joi.string().custom(objectId).optional(),
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
  params: Joi.object()
    .keys({
      teamMemberId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim(),
      email: Joi.string().email().optional().trim(),
      memberSinceLabel: Joi.string().optional().trim().allow('', null),
      projectsCount: Joi.number().integer().min(0).optional(),
      position: Joi.string().optional().trim().allow('', null),
      coverImageUrl: Joi.string().uri().optional().allow('', null),
      avatarImageUrl: Joi.string().uri().optional().allow('', null),
      teamGroup: Joi.string().valid(...TEAM_GROUPS).optional(),
      teamId: Joi.string().custom(objectId).optional(),
      onlineStatus: Joi.string().valid('online', 'offline').optional(),
      lastSeenLabel: Joi.string().optional().trim().allow('', null),
      isStarred: Joi.boolean().optional(),
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

export {
  createTeamMember,
  getTeamMembers,
  getTeamMember,
  updateTeamMember,
  deleteTeamMember,
};

