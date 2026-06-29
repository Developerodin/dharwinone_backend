import Joi from 'joi';

const objectId = Joi.string().custom((value, helpers) => {
  if (!value || !/^[a-fA-F0-9]{24}$/.test(value)) {
    return helpers.error('any.invalid');
  }
  return value;
}, 'objectId');

export const listCompanyPhoneNumbers = {
  query: Joi.object({
    q: Joi.string().allow('').optional(),
    assignedTo: objectId.optional(),
    departmentId: objectId.optional(),
    teamId: objectId.optional(),
    isActive: Joi.string().valid('true', 'false').optional(),
    unassigned: Joi.string().valid('true', 'false').optional(),
  }),
};

export const updateCompanyPhoneNumber = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    friendlyName: Joi.string().max(120).allow('').optional(),
    assignedTo: objectId.allow(null).optional(),
    departmentId: objectId.allow(null).optional(),
    teamId: objectId.allow(null).optional(),
    isActive: Joi.boolean().optional(),
  }).min(1),
};

export const assignPhoneNumberToUser = {
  body: Joi.object({
    userId: objectId.required(),
    companyPhoneNumberId: objectId.allow(null).optional(),
  }),
};
