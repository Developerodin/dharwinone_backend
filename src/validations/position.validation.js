import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createPosition = {
  body: Joi.object().keys({
    name: Joi.string().required().trim(),
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
    })
    .min(1),
};

const deletePosition = {
  params: Joi.object().keys({
    positionId: Joi.string().custom(objectId),
  }),
};

export { createPosition, getPositions, getPosition, updatePosition, deletePosition };
