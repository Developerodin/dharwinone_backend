import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createCategory = {
  body: Joi.object().keys({
    name: Joi.string().required().trim(),
  }),
};

const getCategories = {
  query: Joi.object().keys({
    name: Joi.string(),
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getCategory = {
  params: Joi.object().keys({
    categoryId: Joi.string().custom(objectId),
  }),
};

const updateCategory = {
  params: Joi.object().keys({
    categoryId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim(),
    })
    .min(1),
};

const deleteCategory = {
  params: Joi.object().keys({
    categoryId: Joi.string().custom(objectId),
  }),
};

export { createCategory, getCategories, getCategory, updateCategory, deleteCategory };
