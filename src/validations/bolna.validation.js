import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { CALL_TAGS, CALL_RELATED_ENTITY_TYPES } from '../models/callRecord.model.js';

const initiateCall = {
  body: Joi.object()
    .keys({
      phone: Joi.string().allow('').trim(),
      candidateName: Joi.string().trim(),
      name: Joi.string().trim(),
      fromPhoneNumber: Joi.string().trim(),
      jobId: Joi.string()
        .custom(objectId)
        .required()
        .messages({ 'any.required': 'jobId is required for job posting verification call' }),
    })
    .or('candidateName', 'name')
    .required(),
};

const initiateCandidateCall = {
  body: Joi.object()
    .keys({
      candidateId: Joi.string().custom(objectId).required(),
      candidateName: Joi.string().required().trim(),
      email: Joi.string().email().required().trim(),
      phoneNumber: Joi.string().required().trim(),
      countryCode: Joi.string().allow('').trim(),
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
    channel: Joi.string().valid('dialer'), // dialer: only the caller's own dialer-placed calls
    // Read-side filter only. Never a way to *assert* a source — the server classifies.
    callSource: Joi.string().valid('ai_agent', 'telephony', 'in_app'),
  }),
};

const deleteCallRecord = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const patchCallRecord = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      notes: Joi.string().allow('').max(2000),
      tags: Joi.array().items(Joi.string().valid(...CALL_TAGS)).max(20),
      relatedTo: Joi.object().keys({
        entityType: Joi.string().valid(...CALL_RELATED_ENTITY_TYPES).allow(null),
        entityId: Joi.string().custom(objectId).allow(null),
      }),
    })
    .min(1),
};

const patchBolnaCandidateAgentSettings = {
  body: Joi.object()
    .keys({
      extraSystemInstructions: Joi.string().allow('').max(8000),
      greetingOverride: Joi.string().allow('').max(500),
    })
    .default({}),
};

export {
  initiateCall,
  initiateCandidateCall,
  getCallStatus,
  getCallRecords,
  deleteCallRecord,
  patchCallRecord,
  patchBolnaCandidateAgentSettings,
};

