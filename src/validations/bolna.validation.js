import Joi from 'joi';
import { objectId } from './custom.validation.js';

const initiateCall = {
  body: Joi.object()
    .keys({
      phone: Joi.string().required().trim(),
      candidateName: Joi.string().required().trim(),
      name: Joi.string().trim(),
      fromPhoneNumber: Joi.string().trim(),
      jobId: Joi.string()
        .custom(objectId)
        .required()
        .messages({ 'any.required': 'jobId is required for job posting verification call' }),
    })
    .required(),
};

const initiateCandidateCall = {
  body: Joi.object()
    .keys({
      candidateId: Joi.string().custom(objectId).required(),
      candidateName: Joi.string().required().trim(),
      email: Joi.string().email().required().trim(),
      phoneNumber: Joi.string().required().trim(),
      countryCode: Joi.string().required().trim(),
      jobId: Joi.string().custom(objectId).required(),
      jobTitle: Joi.string().required().trim(),
      companyName: Joi.string().required().trim(),
    })
    .required(),
};

const getCallStatus = {
  params: Joi.object().keys({
    executionId: Joi.string().required().trim(),
  }),
};

const getCallRecords = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
    search: Joi.string().trim().allow(''),
    status: Joi.string().trim().allow(''),
    language: Joi.string().trim().allow(''),
    sortBy: Joi.string().valid('date', 'createdAt').default('createdAt'),
    order: Joi.string().valid('asc', 'desc').default('desc'),
  }),
};

const deleteCallRecord = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const patchBolnaCandidateAgentSettings = {
  body: Joi.object()
    .keys({
      extraSystemInstructions: Joi.string().allow('').max(8000),
      greetingOverride: Joi.string().allow('').max(500),
    })
    .min(1)
    .required(),
};

export {
  initiateCall,
  initiateCandidateCall,
  getCallStatus,
  getCallRecords,
  deleteCallRecord,
  patchBolnaCandidateAgentSettings,
};

