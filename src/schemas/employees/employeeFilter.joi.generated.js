/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: src/schemas/employees/employeeFilter.schema.json
 * Regenerate: npm run generate:employee-filters
 */
import Joi from 'joi';

const employeeFilterSchema = Joi.object().keys({
  employmentStatus: Joi.string().valid('current', 'resigned', 'all'),
  compensationType: Joi.string().valid('paid', 'unpaid'),
  search: Joi.string(),
  fullName: Joi.string(),
  email: Joi.string(),
  employeeId: Joi.string(),
  id: Joi.string(),
  agent: Joi.string(),
  designation: Joi.string(),
  agentIds: Joi.array().items(Joi.string()),
});

const employeeStructuredQuerySchema = Joi.object().keys({
  entity: Joi.string().valid('employees').required(),
  operations: Joi.array()
    .items(Joi.string().valid('count', 'list', 'get'))
    .min(1)
    .required(),
  filters: employeeFilterSchema.optional(),
  relations: Joi.array()
    .items(
      Joi.object({
        entity: Joi.string().required(),
        relation: Joi.string().required(),
        id: Joi.string().optional(),
        name: Joi.string().optional(),
      })
    )
    .optional(),
  scope: Joi.object({
    module: Joi.string().optional(),
    projectId: Joi.string().optional(),
    teamId: Joi.string().optional(),
  }).optional(),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(50),
  }).optional(),
  getAll: Joi.boolean().default(false),
});

export { employeeFilterSchema, employeeStructuredQuerySchema };
