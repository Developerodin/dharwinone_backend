import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { PLACEMENT_STATUSES, PRE_BOARDING_STATUSES } from '../constants/atsPipeline.js';

const PLACEMENT_STATUS_SET = new Set(PLACEMENT_STATUSES);

const getPlacements = {
  query: Joi.object().keys({
    jobId: Joi.string().custom(objectId).optional(),
    candidateId: Joi.string().custom(objectId).optional(),
    status: Joi.string()
      .optional()
      .custom((value, helpers) => {
        if (value == null || value === '') return value;
        const parts = String(value)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const p of parts) {
          if (!PLACEMENT_STATUS_SET.has(p)) {
            return helpers.error('any.invalid');
          }
        }
        return value;
      }),
    preBoardingStatus: Joi.string()
      .valid(...PRE_BOARDING_STATUSES)
      .optional(),
    // Queue selector: owns the offerStatus + stage-discriminator filter; `status` narrows within it.
    stage: Joi.string().valid('preBoarding', 'onboarding').optional(),
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

const taskPatchSchema = Joi.object({
  _id: Joi.string().custom(objectId).required(),
  title: Joi.string().trim().optional(),
  required: Joi.boolean().optional(),
  done: Joi.boolean().optional(),
  order: Joi.number().optional(),
});

const updatePlacement = {
  params: Joi.object().keys({
    placementId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...PLACEMENT_STATUSES)
        .optional(),
      preBoardingStatus: Joi.string()
        .valid(...PRE_BOARDING_STATUSES)
        .optional(),
      joiningDate: Joi.date().optional(),
      notes: Joi.string().trim().optional().allow('', null),
      preboardingGateBypass: Joi.boolean().optional(),
      suppressCandidateNotifications: Joi.boolean().optional(),
      backgroundVerification: backgroundVerificationSchema.optional(),
      assetAllocation: Joi.array().items(assetAllocationSchema).optional(),
      itAccess: Joi.array().items(itAccessSchema).optional(),
      preBoardingTasks: Joi.array().items(taskPatchSchema).optional(),
      onboardingTasks: Joi.array().items(taskPatchSchema).optional(),
    })
    .min(1),
};

export { getPlacements, getPlacement, updatePlacement };
