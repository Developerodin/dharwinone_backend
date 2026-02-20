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

const createOffer = {
  body: Joi.object()
    .keys({
      jobApplicationId: Joi.string().custom(objectId).required(),
      ctcBreakdown: ctcBreakdown.optional(),
      joiningDate: Joi.date().optional().allow(null),
      offerValidityDate: Joi.date().optional().allow(null),
      notes: Joi.string().trim().optional().allow('', null),
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
    })
    .min(1),
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

export { createOffer, getOffer, updateOffer, getOffers, deleteOffer };
