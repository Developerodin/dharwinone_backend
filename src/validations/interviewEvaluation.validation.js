import Joi from 'joi';
import { objectId } from './custom.validation.js';

const MAX_CONTEXT_WINDOW = 5;

const meetingIdParams = {
  params: Joi.object().keys({
    id: Joi.alternatives().try(objectId, Joi.string().trim().max(128)).required(),
  }),
};

export const getMeetingTranscript = {
  ...meetingIdParams,
  query: Joi.object().keys({
    version: Joi.number().integer().min(1).optional(),
  }),
};

export const getMeetingTranscriptUtteranceContext = {
  params: Joi.object().keys({
    id: Joi.alternatives().try(objectId, Joi.string().trim().max(128)).required(),
    utteranceId: Joi.string().trim().min(1).max(128).required(),
  }),
  query: Joi.object().keys({
    version: Joi.number().integer().min(1).optional(),
    window: Joi.number().integer().min(1).max(MAX_CONTEXT_WINDOW).optional(),
  }),
};

export const getMeetingSummary = {
  ...meetingIdParams,
  query: Joi.object().keys({
    version: Joi.number().integer().min(1).optional(),
  }),
};
