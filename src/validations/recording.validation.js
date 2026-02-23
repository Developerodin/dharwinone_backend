import Joi from 'joi';

const listRecordings = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
  }),
};

export { listRecordings };
