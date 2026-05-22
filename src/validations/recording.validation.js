import Joi from 'joi';

const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/);

const listRecordings = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
    status: Joi.string().trim().allow('', null),
    q: Joi.string().trim().allow('', null),
    source: Joi.string().valid('interview', 'meeting', '').allow('', null).optional(),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().optional(),
  }),
};

const getTranscript = {
  params: Joi.object().keys({
    recordingId: objectId.required(),
  }),
};

export { listRecordings, getTranscript };
