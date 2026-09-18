import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { INTERVIEW_ROUND_TYPES } from '../constants/interviewLinkage.js';
import { criteriaWeightError } from '../constants/interviewRubric.js';

/**
 * Criterion keys are free-form on purpose — an admin invents the categories, so there is
 * no enum to validate against. The charset is restricted so a key stays usable as an
 * object key and as a DOM id.
 */
const criterionSchema = Joi.object({
  key: Joi.string()
    .trim()
    .pattern(/^[a-zA-Z0-9_-]{1,40}$/)
    .required()
    .messages({
      'string.pattern.base':
        'A criterion key may use letters, numbers, hyphen and underscore only (max 40 characters).',
    }),
  label: Joi.string().trim().min(1).max(80).required(),
  weight: Joi.number().integer().min(0).max(100).required(),
  scaleMin: Joi.number().integer().min(0).max(9).default(1),
  scaleMax: Joi.number().integer().min(1).max(10).default(5),
});

/** Weight sum and duplicate keys are ONE shared rule, not a second Joi expression. */
const criteriaList = Joi.array()
  .items(criterionSchema)
  .min(1)
  .max(20)
  .custom((value, helpers) => {
    const reason = criteriaWeightError(value);
    return reason ? helpers.message(reason) : value;
  });

const appliesToSchema = Joi.object({
  jobId: Joi.string().custom(objectId).allow(null, ''),
  roundType: Joi.string()
    .valid(...INTERVIEW_ROUND_TYPES)
    .allow(null, ''),
});

const createRubricTemplate = {
  body: Joi.object().keys({
    name: Joi.string().trim().min(1).max(120).required(),
    description: Joi.string().trim().allow('', null).max(500),
    criteria: criteriaList.required(),
    appliesTo: appliesToSchema,
    isDefault: Joi.boolean(),
  }),
};

const getRubricTemplates = {
  query: Joi.object().keys({
    includeArchived: Joi.boolean().truthy('true', '1').falsy('false', '0').default(false),
    sortBy: Joi.string().default('-createdAt'),
    limit: Joi.number().integer().min(1).max(100).default(50),
    page: Joi.number().integer().min(1).default(1),
  }),
};

const resolveRubric = {
  query: Joi.object().keys({
    jobId: Joi.string().custom(objectId).allow(null, ''),
    roundType: Joi.string()
      .valid(...INTERVIEW_ROUND_TYPES)
      .allow(null, ''),
  }),
};

const getRubricTemplate = {
  params: Joi.object().keys({ templateId: Joi.string().custom(objectId).required() }),
};

const updateRubricTemplate = {
  params: Joi.object().keys({ templateId: Joi.string().custom(objectId).required() }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(1).max(120),
      description: Joi.string().trim().allow('', null).max(500),
      criteria: criteriaList,
      appliesTo: appliesToSchema,
      isDefault: Joi.boolean(),
    })
    .min(1),
};

export default {
  createRubricTemplate,
  getRubricTemplates,
  resolveRubric,
  getRubricTemplate,
  updateRubricTemplate,
};
