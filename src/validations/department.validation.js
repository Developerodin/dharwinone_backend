import Joi from 'joi';
import { objectId } from './custom.validation.js';

// Hex colour (#RRGGBB) or empty string to clear and fall back to the chart's auto colour.
const colorField = Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).allow('').optional()
  .messages({ 'string.pattern.base': 'color must be a hex value like #0ea5e9' });

export const createDepartment = {
  body: Joi.object().keys({
    name: Joi.string().required().trim(),
    code: Joi.string().trim().max(40).allow('').optional(),
    color: colorField,
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
    color: colorField,
  }).min(1),
};
export const deactivateDepartment = {
  params: Joi.object().keys({ departmentId: Joi.string().required().custom(objectId) }),
};
export const reactivateDepartment = {
  params: Joi.object().keys({ departmentId: Joi.string().required().custom(objectId) }),
};
