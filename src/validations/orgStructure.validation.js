import Joi from 'joi';
import { objectId } from './custom.validation.js';

const TYPES = ['ceo', 'manager', 'supervisor', 'department'];

export const createOrgUnit = {
  body: Joi.object().keys({
    name: Joi.string().required().trim(),
    type: Joi.string().required().valid(...TYPES),
    parentId: Joi.string().custom(objectId).allow(null).optional(),
    departmentId: Joi.string().custom(objectId).allow(null).optional(),
    headEmployeeId: Joi.string().custom(objectId).allow(null).optional(),
    directToCeo: Joi.boolean().optional(),
    order: Joi.number().integer().optional(),
  }),
};
export const updateOrgUnit = {
  params: Joi.object().keys({ orgUnitId: Joi.string().required().custom(objectId) }),
  body: Joi.object().keys({
    name: Joi.string().trim(),
    departmentId: Joi.string().custom(objectId).allow(null),
    directToCeo: Joi.boolean(),
    order: Joi.number().integer(),
  }).min(1),
};
export const reparentOrgUnit = {
  params: Joi.object().keys({ orgUnitId: Joi.string().required().custom(objectId) }),
  body: Joi.object().keys({ parentId: Joi.string().custom(objectId).allow(null).required() }),
};
export const assignHead = {
  params: Joi.object().keys({ orgUnitId: Joi.string().required().custom(objectId) }),
  body: Joi.object().keys({ headEmployeeId: Joi.string().custom(objectId).allow(null).required() }),
};
export const deactivateOrgUnit = {
  params: Joi.object().keys({ orgUnitId: Joi.string().required().custom(objectId) }),
};
