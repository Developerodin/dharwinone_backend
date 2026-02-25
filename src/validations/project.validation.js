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
        .valid('High', 'Medium', 'Low')
        .optional()
        .default('Medium'),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      assignedTeams: Joi.array().items(Joi.string().custom(objectId)).optional(),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      attachments: Joi.array().items(Joi.string().uri()).optional(),
      completedTasks: Joi.number().integer().min(0).optional(),
      totalTasks: Joi.number().integer().min(0).optional(),
    })
    .required(),
};

const getProjects = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.string().valid('Inprogress', 'On hold', 'completed').optional(),
    priority: Joi.string().valid('High', 'Medium', 'Low').optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
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
      priority: Joi.string().valid('High', 'Medium', 'Low').optional(),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      assignedTeams: Joi.array().items(Joi.string().custom(objectId)).optional(),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      attachments: Joi.array().items(Joi.string().uri()).optional(),
      completedTasks: Joi.number().integer().min(0).optional(),
      totalTasks: Joi.number().integer().min(0).optional(),
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
