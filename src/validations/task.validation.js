import Joi from 'joi';
import { objectId } from './custom.validation.js';

const TASK_STATUSES = ['new', 'todo', 'on_going', 'in_review', 'completed'];
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const commaSeparatedObjectIds = Joi.string().custom((value, helpers) => {
  const parts = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const { error } = Joi.string().custom(objectId).validate(part);
    if (error) return helpers.error('any.invalid');
  }
  return value;
}, 'comma-separated objectIds');

const commaSeparatedPriorities = Joi.string().custom((value, helpers) => {
  const parts = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!TASK_PRIORITIES.includes(part)) return helpers.error('any.invalid');
  }
  return value;
}, 'comma-separated priorities');

/**
 * Multi-status list, e.g. "new,todo,on_going,in_review" for "open tasks".
 * A single value still validates, so every existing caller is unaffected.
 * Mirrors {@link commaSeparatedPriorities}; the service applies both via applyCommaFilter.
 */
const commaSeparatedStatuses = Joi.string().custom((value, helpers) => {
  const parts = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!TASK_STATUSES.includes(part)) return helpers.error('any.invalid');
  }
  return value;
}, 'comma-separated statuses');

/** Query flags: accept Joi booleans plus URL-style "1"/"0" (task board url-state). */
const queryBooleanFlag = Joi.alternatives()
  .try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0'))
  .optional();

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
      priority: Joi.string()
        .valid(...TASK_PRIORITIES)
        .optional()
        .default('medium'),
      sprintId: Joi.string().custom(objectId).optional().allow(null),
      dueDate: Joi.date().optional().allow(null),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      requiredSkills: Joi.array().items(Joi.string().trim().max(128)).max(30).optional(),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      projectId: Joi.string().custom(objectId).optional(),
      imageUrl: Joi.string().uri().optional().allow('', null),
      order: Joi.number().integer().optional(),
    })
    .required(),
};

const getTasks = {
  query: Joi.object().keys({
    status: commaSeparatedStatuses.optional(),
    projectId: Joi.string().custom(objectId).optional(),
    priority: commaSeparatedPriorities.optional(),
    sprintId: commaSeparatedObjectIds.optional(),
    createdBy: commaSeparatedObjectIds.optional(),
    search: Joi.string().optional(),
    assignedToMe: queryBooleanFlag,
    unassigned: queryBooleanFlag,
    leaving: queryBooleanFlag,
    reassigned: queryBooleanFlag,
    /**
     * Only tasks that carry a dueDate. The dashboard task widget orders by dueDate,
     * and Mongo sorts missing values FIRST ascending — without this an undated backlog
     * would fill the widget and hide every overdue task. Omitted => unchanged behaviour.
     */
    hasDueDate: queryBooleanFlag,
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(200).optional(),
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
      priority: Joi.string().valid(...TASK_PRIORITIES).optional(),
      sprintId: Joi.string().custom(objectId).optional().allow(null),
      dueDate: Joi.date().optional().allow(null),
      tags: Joi.array().items(Joi.string().trim()).optional(),
      requiredSkills: Joi.array().items(Joi.string().trim().max(128)).max(30).optional(),
      assignedTo: Joi.array().items(Joi.string().custom(objectId)).optional(),
      projectId: Joi.string().custom(objectId).optional(),
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

const addTaskComment = {
  params: Joi.object()
    .keys({
      taskId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      content: Joi.string().required().trim().min(1).max(2000).messages({
        'string.empty': 'Comment content is required',
      }),
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
  addTaskComment,
};
