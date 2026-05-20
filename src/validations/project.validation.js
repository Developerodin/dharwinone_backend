import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createProject = {
  body: Joi.object()
    .keys({
      name: Joi.string().required().trim().messages({
        'any.required': 'Project name is required',
        'string.empty': 'Project name cannot be empty',
      }),
      projectManager: Joi.string().optional().trim().allow('', null),
      clientStakeholder: Joi.string().optional().trim().allow('', null),
      description: Joi.string().optional().trim().allow('', null),
      startDate: Joi.date().optional().allow(null),
      endDate: Joi.date().optional().allow(null),
      status: Joi.string()
        .valid('Inprogress', 'On hold', 'completed')
        .optional()
        .default('Inprogress'),
      priority: Joi.string()
        .valid('low', 'medium', 'high', 'urgent')
        .optional()
        .default('medium'),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      assignedTeams: Joi.array().items(Joi.string().custom(objectId)).optional(),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      attachments: Joi.array().items(Joi.string().uri()).optional(),
    })
    .required(),
};

const getProjects = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.string().valid('Inprogress', 'On hold', 'completed').optional(),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent').optional(),
    /** When true, restrict to projects created by the current user (even for admins). */
    mine: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(200).optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getProject = {
  params: Joi.object()
    .keys({
      projectId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

const updateProject = {
  params: Joi.object()
    .keys({
      projectId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim(),
      projectManager: Joi.string().optional().trim().allow('', null),
      clientStakeholder: Joi.string().optional().trim().allow('', null),
      description: Joi.string().optional().trim().allow('', null),
      startDate: Joi.date().optional().allow(null),
      endDate: Joi.date().optional().allow(null),
      status: Joi.string().valid('Inprogress', 'On hold', 'completed').optional(),
      priority: Joi.string().valid('low', 'medium', 'high', 'urgent').optional(),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      assignedTeams: Joi.array().items(Joi.string().custom(objectId)).optional(),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      attachments: Joi.array().items(Joi.string().uri()).optional(),
    })
    .min(1),
};

const deleteProject = {
  params: Joi.object()
    .keys({
      projectId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

export { createProject, getProjects, getProject, updateProject, deleteProject };
