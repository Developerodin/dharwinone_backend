import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createPosition = {
  body: Joi.object().keys({
    name: Joi.string().required().trim(),
    department: Joi.string().trim().max(100).allow('').optional(),
    skillsSuggested: Joi.array().items(Joi.string().trim().max(80)).max(50).optional(),
  }),
};

const getPositions = {
  query: Joi.object().keys({
    name: Joi.string(),
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

/** Curriculum Setup roster: page / limit / search / folderIds / sortBy=field:dir,_id:asc */
const getPositionRoster = {
  query: Joi.object().keys({
    search: Joi.string().allow('').optional(),
    /** Comma-separated category (folder) ObjectIds. OR semantics across folders. */
    folderIds: Joi.string().allow('').optional(),
    sortBy: Joi.string().allow('').optional(),
    limit: Joi.number().integer().min(1).max(2000),
    page: Joi.number().integer().min(1),
  }),
};

const getPosition = {
  params: Joi.object().keys({
    positionId: Joi.string().custom(objectId),
  }),
};

const updatePosition = {
  params: Joi.object().keys({
    positionId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim(),
      department: Joi.string().trim().max(100).allow('').optional(),
      skillsSuggested: Joi.array().items(Joi.string().trim().max(80)).max(50).optional(),
      autoEnrollNewHires: Joi.boolean(),
    })
    .min(1),
};

const deletePosition = {
  params: Joi.object().keys({
    positionId: Joi.string().custom(objectId),
  }),
};

const getPositionEmployees = {
  params: Joi.object().keys({
    positionId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const setPositionModules = {
  params: Joi.object().keys({
    positionId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    moduleIds: Joi.array().items(Joi.string().custom(objectId)).required(),
  }),
};

const bulkEnroll = {
  params: Joi.object().keys({
    positionId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    moduleIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
    action: Joi.string().valid('assign', 'remove').required(),
    studentIds: Joi.array().items(Joi.string().custom(objectId)),
  }),
};

export {
  createPosition,
  getPositions,
  getPositionRoster,
  getPosition,
  getPositionEmployees,
  setPositionModules,
  bulkEnroll,
  updatePosition,
  deletePosition,
};
