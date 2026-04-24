import Joi from 'joi';
import { objectId } from './custom.validation.js';

const STATUS_VALUES = ['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected'];

const ctcBreakdown = Joi.object({
  base: Joi.number().optional().min(0),
  hra: Joi.number().optional().min(0),
  specialAllowances: Joi.number().optional().min(0),
  otherAllowances: Joi.number().optional().min(0),
  gross: Joi.number().optional().min(0),
  currency: Joi.string().optional().trim().default('INR'),
});

const jobTypeLetter = Joi.string().valid('FT_40', 'PT_25', 'INTERN_UNPAID');

const supervisor = Joi.object({
  firstName: Joi.string().trim().allow(''),
  lastName: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().trim().allow(''),
});

const letterBodyKeys = {
  letterFullName: Joi.string().trim().allow(''),
  letterAddress: Joi.string().trim().allow(''),
  positionTitle: Joi.string().trim().allow(''),
  jobType: jobTypeLetter,
  weeklyHours: Joi.number().valid(25, 40),
  workLocation: Joi.string().trim().allow(''),
  roleResponsibilities: Joi.array().items(Joi.string().trim()),
  trainingOutcomes: Joi.array().items(Joi.string().trim()),
  compensationNarrative: Joi.string().trim().allow(''),
  academicAlignmentNote: Joi.string().trim().allow(''),
  employmentEligibilityLines: Joi.array().items(Joi.string().trim()),
  supervisor,
  letterDate: Joi.date().allow(null),
};

const createOffer = {
  body: Joi.object()
    .keys({
      jobApplicationId: Joi.string().custom(objectId).required(),
      ctcBreakdown: ctcBreakdown.optional(),
      joiningDate: Joi.date().optional().allow(null),
      offerValidityDate: Joi.date().optional().allow(null),
      notes: Joi.string().trim().optional().allow('', null),
      ...letterBodyKeys,
    })
    .required(),
};

const getOffer = {
  params: Joi.object().keys({
    offerId: Joi.string().custom(objectId).required(),
  }),
};

const updateOffer = {
  params: Joi.object().keys({
    offerId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string().valid(...STATUS_VALUES).optional(),
      ctcBreakdown: ctcBreakdown.optional(),
      joiningDate: Joi.date().optional().allow(null),
      offerValidityDate: Joi.date().optional().allow(null),
      notes: Joi.string().trim().optional().allow('', null),
      rejectionReason: Joi.string().trim().optional().allow('', null),
      ...letterBodyKeys,
    })
    .min(1),
};

const letterDefaults = {
  query: Joi.object().keys({
    positionTitle: Joi.string().trim().allow(''),
  }),
};

const generateLetter = {
  params: Joi.object().keys({
    offerId: Joi.string().custom(objectId).required(),
  }),
};

const getOffers = {
  query: Joi.object().keys({
    jobId: Joi.string().custom(objectId).optional(),
    candidateId: Joi.string().custom(objectId).optional(),
    status: Joi.string().valid(...STATUS_VALUES).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const deleteOffer = {
  params: Joi.object().keys({
    offerId: Joi.string().custom(objectId).required(),
  }),
};

const enhanceRoles = {
  body: Joi.object()
    .keys({
      jobTitle: Joi.string().trim().min(1).max(300).required(),
      existingRoles: Joi.string().trim().allow('').max(20000),
      existingTraining: Joi.string().trim().allow('').max(20000),
      isInternship: Joi.boolean().optional(),
      enhanceFocus: Joi.string().valid('roles', 'training', 'both').optional(),
    })
    .required(),
};

export { createOffer, getOffer, updateOffer, getOffers, deleteOffer, letterDefaults, generateLetter, enhanceRoles };
