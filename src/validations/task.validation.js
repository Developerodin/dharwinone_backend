import Joi from 'joi';
import { objectId } from './custom.validation.js';

const TASK_STATUSES = ['new', 'todo', 'on_going', 'in_review', 'completed'];

const createTask = {
  body: Joi.object()
    .keys({
      title: Joi.string().required().trim().messages({
        'any.required': 'Task title is required',
        'string.empty': 'Task title cannot be empty',
      }),
      description: Joi.string().optional().trim().allow('', null),
      taskCode: Joi.string().optional().trim().allow('', null),
      status: Joi.string()
        .valid(...TASK_STATUSES)
        .optional()
        .default('new'),
      dueDate: Joi.date().optional().allow(null),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      projectId: Joi.string().custom(objectId).optional(),
      likesCount: Joi.number().integer().min(0).optional(),
      commentsCount: Joi.number().integer().min(0).optional(),
      imageUrl: Joi.string().uri().optional().allow('', null),
      order: Joi.number().integer().optional(),
    })
    .required(),
};

const getTasks = {
  query: Joi.object().keys({
    status: Joi.string().valid(...TASK_STATUSES).optional(),
    projectId: Joi.string().custom(objectId).optional(),
    search: Joi.string().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getTask = {
  params: Joi.object()
    .keys({
      taskId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

const updateTask = {
  params: Joi.object()
    .keys({
      taskId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      title: Joi.string().optional().trim(),
      description: Joi.string().optional().trim().allow('', null),
      taskCode: Joi.string().optional().trim().allow('', null),
      status: Joi.string().valid(...TASK_STATUSES).optional(),
      dueDate: Joi.date().optional().allow(null),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      projectId: Joi.string().custom(objectId).optional(),
      likesCount: Joi.number().integer().min(0).optional(),
      commentsCount: Joi.number().integer().min(0).optional(),
      imageUrl: Joi.string().uri().optional().allow('', null),
      order: Joi.number().integer().optional(),
    })
    .min(1),
};

const updateTaskStatus = {
  params: Joi.object()
    .keys({
      taskId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      status: Joi.string().valid(...TASK_STATUSES).required(),
      order: Joi.number().integer().optional(),
    })
    .required(),
};

const deleteTask = {
  params: Joi.object()
    .keys({
      taskId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

export {
  createTask,
  getTasks,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
};
