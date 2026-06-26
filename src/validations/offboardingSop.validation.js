import Joi from 'joi';
import { objectId } from './custom.validation.js';

const step = Joi.object({
  checkerKey: Joi.string().required().trim(),
  label: Joi.string().required().trim(),
  description: Joi.string().allow('', null).trim(),
  sortOrder: Joi.number().integer().min(0),
  enabled: Joi.boolean(),
  linkTemplate: Joi.string().allow('', null).trim(),
});

export const saveConfig = {
  body: Joi.object({
    steps: Joi.array().items(step).min(1).required(),
  }),
};

export const employeeIdParam = {
  params: Joi.object({
    employeeId: Joi.string().required().custom(objectId),
  }),
};

export const runStep = {
  params: Joi.object({
    employeeId: Joi.string().required().custom(objectId),
    stepKey: Joi.string()
      .required()
      .valid('email_deactivated', 'tasks_reassigned', 'org_team_disabled'),
  }),
  body: Joi.object({
    toUserIds: Joi.array().items(Joi.string().custom(objectId)),
  }),
};
