import Joi from 'joi';
import { objectId } from './custom.validation.js';

export const createDepartment = {
  body: Joi.object().keys({
    name: Joi.string().required().trim(),
    code: Joi.string().trim().max(40).allow('').optional(),
  }),
};
export const getDepartments = {
  query: Joi.object().keys({
    search: Joi.string().allow('').optional(),
    isActive: Joi.boolean().optional(),
    all: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string(), limit: Joi.number().integer(), page: Joi.number().integer(),
  }),
};
export const updateDepartment = {
  params: Joi.object().keys({ departmentId: Joi.string().required().custom(objectId) }),
  body: Joi.object().keys({
    name: Joi.string().trim(),
    code: Joi.string().trim().max(40).allow('').optional(),
  }).min(1),
};
export const deactivateDepartment = {
  params: Joi.object().keys({ departmentId: Joi.string().required().custom(objectId) }),
};
