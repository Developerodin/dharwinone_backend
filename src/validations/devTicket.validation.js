import Joi from 'joi';
import { objectId, devTicketRef } from './custom.validation.js';
import { LABELS, LINK_RELS, CATEGORIES } from '../models/devTicket.model.js';

const gitFields = {
  git: Joi.object()
    .keys({
      branch: Joi.string().trim().allow('', null),
      pullRequests: Joi.array().items(
        Joi.object().keys({
          number: Joi.number().integer().optional(),
          title: Joi.string().trim().optional(),
          url: Joi.string().uri().optional(),
        })
      ),
      commits: Joi.array().items(
        Joi.object().keys({
          sha: Joi.string().trim().optional(),
          message: Joi.string().trim().optional(),
          url: Joi.string().uri().optional(),
        })
      ),
    })
    .optional(),
};

// Multipart requests serialize arrays as JSON strings (and a single value as a
// bare string). Coerce to an array before validating so create works whether or
// not attachments are present (attachments force multipart/form-data).
const coerceLabels = (value, helpers) => {
  if (value === undefined || value === null || value === '') return [];
  let arr = value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('[')) {
      try { arr = JSON.parse(t); } catch { return helpers.error('any.invalid'); }
    } else {
      arr = [t];
    }
  }
  if (!Array.isArray(arr)) return helpers.error('any.invalid');
  const cleaned = [...new Set(arr.map((l) => String(l)))];
  if (cleaned.some((l) => !LABELS.includes(l))) return helpers.error('any.invalid');
  return cleaned;
};

const labelsField = Joi.any().custom(coerceLabels).messages({
  'any.invalid': `labels must contain only valid values: ${LABELS.join(', ')}`,
});

const createDevTicket = {
  body: Joi.object()
    .keys({
      title: Joi.string().required().trim().min(5).max(200).messages({
        'string.min': 'Title must be at least 5 characters long',
        'string.max': 'Title must not exceed 200 characters',
        'any.required': 'Title is required',
      }),
      description: Joi.string().required().trim().min(10).max(5000).messages({
        'string.min': 'Description must be at least 10 characters long',
        'string.max': 'Description must not exceed 5000 characters',
        'any.required': 'Description is required',
      }),
      priority: Joi.string().valid('Low', 'Medium', 'High', 'Urgent').default('Medium'),
      severity: Joi.string().valid('Minor', 'Major', 'Critical', 'Blocker').default('Major'),
      category: Joi.string().valid(...CATEGORIES).default('Bug'),
      module: Joi.string().trim().max(100).allow('', null),
      environment: Joi.string().valid('Staging', 'Production').default('Staging'),
      stepsToReproduce: Joi.string().trim().max(5000).allow('', null),
      pageUrl: Joi.string().trim().max(500).allow('', null),
      labels: labelsField,
      assignedTo: Joi.alternatives().try(
        Joi.string().custom(objectId),
        Joi.string().valid('', null).empty('').default(null)
      ),
      ...gitFields,
    })
    .required(),
};

const getDevTickets = {
  query: Joi.object().keys({
    status: Joi.string().valid('Open', 'In Progress', 'Resolved', 'Closed'),
    priority: Joi.string().valid('Low', 'Medium', 'High', 'Urgent'),
    severity: Joi.string().valid('Minor', 'Major', 'Critical', 'Blocker'),
    category: Joi.string().valid(...CATEGORIES),
    module: Joi.string().trim(),
    environment: Joi.string().valid('Staging', 'Production'),
    label: Joi.string().valid(...LABELS),
    scope: Joi.string().valid('all', 'mine', 'reported', 'unassigned'),
    search: Joi.string().trim().max(200).allow(''),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getDevTicket = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
};

const updateDevTicket = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().trim().min(5).max(200).messages({
        'string.min': 'Title must be at least 5 characters long',
        'string.max': 'Title must not exceed 200 characters',
      }),
      description: Joi.string().trim().min(10).max(5000).messages({
        'string.min': 'Description must be at least 10 characters long',
        'string.max': 'Description must not exceed 5000 characters',
      }),
      status: Joi.string().valid('Open', 'In Progress', 'Resolved', 'Closed'),
      priority: Joi.string().valid('Low', 'Medium', 'High', 'Urgent'),
      severity: Joi.string().valid('Minor', 'Major', 'Critical', 'Blocker'),
      category: Joi.string().valid(...CATEGORIES),
      module: Joi.string().trim().max(100).allow('', null),
      environment: Joi.string().valid('Staging', 'Production'),
      stepsToReproduce: Joi.string().trim().max(5000).allow('', null),
      pageUrl: Joi.string().trim().max(500).allow('', null),
      labels: Joi.array().items(Joi.string().valid(...LABELS)).unique(),
      assignedTo: Joi.alternatives().try(
        Joi.string().custom(objectId),
        Joi.string().valid('', null).empty('').default(null)
      ),
      ...gitFields,
    })
    .min(1)
    .required(),
};

const addComment = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      content: Joi.string().required().trim().min(1).max(2000).messages({
        'string.max': 'Comment must not exceed 2000 characters',
        'any.required': 'Comment content is required',
      }),
    })
    .required(),
};

const addAttachments = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
};

const removeAttachment = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    key: Joi.string().trim().max(1024).required(),
  }),
};

const deleteDevTicket = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
};

const bulkUpdate = {
  body: Joi.object()
    .keys({
      ids: Joi.array().items(Joi.string().custom(objectId)).min(1).max(50).required(),
      action: Joi.object()
        .keys({
          status: Joi.string().valid('Open', 'In Progress', 'Resolved', 'Closed'),
          assignedTo: Joi.alternatives().try(
            Joi.string().custom(objectId),
            Joi.string().valid('', null).empty('').default(null)
          ),
          addLabel: Joi.string().valid(...LABELS),
        })
        .min(1)
        .required(),
    })
    .required(),
};

const watchTicket = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
};

const linkTicket = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      rel: Joi.string()
        .valid(...LINK_RELS)
        .required(),
      ticketId: Joi.string().custom(devTicketRef).required(),
    })
    .required(),
};

const unlinkTicket = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
    linkId: Joi.string().custom(objectId).required(),
  }),
};

const addReaction = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      commentId: Joi.string().custom(objectId).required(),
      emoji: Joi.string().trim().min(1).max(32).required(),
    })
    .required(),
};

const removeReaction = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      commentId: Joi.string().custom(objectId).required(),
      emoji: Joi.string().trim().min(1).max(32).required(),
    })
    .required(),
};

export {
  createDevTicket,
  getDevTickets,
  getDevTicket,
  updateDevTicket,
  addComment,
  addAttachments,
  removeAttachment,
  deleteDevTicket,
  bulkUpdate,
  watchTicket,
  linkTicket,
  unlinkTicket,
  addReaction,
  removeReaction,
};
