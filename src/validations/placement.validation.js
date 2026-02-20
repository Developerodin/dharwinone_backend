import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getPlacements = {
  query: Joi.object().keys({
    jobId: Joi.string().custom(objectId).optional(),
    candidateId: Joi.string().custom(objectId).optional(),
    status: Joi.string().valid('Pending', 'Joined', 'Deferred', 'Cancelled').optional(),
    preBoardingStatus: Joi.string().valid('Pending', 'In Progress', 'Completed').optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getPlacement = {
  params: Joi.object().keys({
    placementId: Joi.string().custom(objectId).required(),
  }),
};

const backgroundVerificationSchema = Joi.object({
  status: Joi.string().valid('Pending', 'In Progress', 'Completed', 'Verified').optional(),
  requestedAt: Joi.date().optional(),
  completedAt: Joi.date().optional(),
  agency: Joi.string().trim().optional(),
  notes: Joi.string().trim().optional().allow('', null),
});

const assetAllocationSchema = Joi.object({
  name: Joi.string().required().trim(),
  type: Joi.string().trim().optional(),
  serialNumber: Joi.string().trim().optional(),
  notes: Joi.string().trim().optional().allow('', null),
});

const itAccessSchema = Joi.object({
  system: Joi.string().required().trim(),
  accessLevel: Joi.string().trim().optional(),
  notes: Joi.string().trim().optional().allow('', null),
});

const updatePlacement = {
  params: Joi.object().keys({
    placementId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string().valid('Pending', 'Joined', 'Deferred', 'Cancelled').optional(),
      preBoardingStatus: Joi.string().valid('Pending', 'In Progress', 'Completed').optional(),
      joiningDate: Joi.date().optional(),
      notes: Joi.string().trim().optional().allow('', null),
      backgroundVerification: backgroundVerificationSchema.optional(),
      assetAllocation: Joi.array().items(assetAllocationSchema).optional(),
      itAccess: Joi.array().items(itAccessSchema).optional(),
    })
    .min(1),
};

export { getPlacements, getPlacement, updatePlacement };
