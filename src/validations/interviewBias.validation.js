import Joi from 'joi';
import { objectId } from './custom.validation.js';

const meetingIdParams = {
  params: Joi.object().keys({
    id: Joi.alternatives().try(objectId, Joi.string().trim().max(128)).required(),
  }),
};

export const getBiasCheck = {
  ...meetingIdParams,
};

export const rerunBiasCheck = {
  ...meetingIdParams,
};
