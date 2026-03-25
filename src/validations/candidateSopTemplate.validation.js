import Joi from 'joi';
import { objectId } from './custom.validation.js';

const sopStep = Joi.object({
  checkerKey: Joi.string().required().trim(),
  label: Joi.string().required().trim(),
  description: Joi.string().allow('', null).trim(),
  sortOrder: Joi.number().integer().min(0),
  enabled: Joi.boolean(),
  linkTemplate: Joi.string().allow('', null).trim(),
});

export const createCandidateSopTemplate = {
  body: Joi.object({
    name: Joi.string().trim(),
    steps: Joi.array().items(sopStep),
    activate: Joi.boolean(),
  }),
};

export const updateCandidateSopTemplate = {
  params: Joi.object({
    templateId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object({
    name: Joi.string().trim(),
    steps: Joi.array().items(sopStep).min(1),
  }).min(1),
};

export const candidateSopTemplateId = {
  params: Joi.object({
    templateId: Joi.string().required().custom(objectId),
  }),
};
