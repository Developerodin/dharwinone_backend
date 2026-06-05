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

export {
  createPosition,
  getPositions,
  getPosition,
  getPositionEmployees,
  setPositionModules,
  updatePosition,
  deletePosition,
};
