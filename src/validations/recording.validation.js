import Joi from 'joi';

const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/);

const listRecordings = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
  }),
};

const getTranscript = {
  params: Joi.object().keys({
    recordingId: objectId.required(),
  }),
};

export { listRecordings, getTranscript };
