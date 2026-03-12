import Joi from 'joi';

const getAtsAnalytics = {
  query: Joi.object().keys({
    range: Joi.string().valid('7d', '30d', '3m', '12m').optional(),
  }),
};

const drillDown = {
  query: Joi.object().keys({
    type: Joi.string()
      .valid('applicationStatus', 'jobStatus', 'jobType', 'applicationFunnel')
      .required(),
    value: Joi.string().required(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

const applicationsOverTimeByCandidates = {
  query: Joi.object().keys({
    candidateIds: Joi.string().required(), // comma-separated ObjectIds
  }),
};

export { getAtsAnalytics, drillDown, applicationsOverTimeByCandidates };
