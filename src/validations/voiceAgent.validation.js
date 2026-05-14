import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createVoiceAgent = {
  body: Joi.object()
    .keys({
      name: Joi.string().required().trim().max(200),
      externalAgentId: Joi.string().required().trim().max(200),
      knowledgeBaseEnabled: Joi.boolean(),
      description: Joi.string().trim().max(2000).allow(''),
    })
    .required(),
};

const updateVoiceAgent = {
  params: Joi.object().keys({
    agentId: Joi.string().required().trim(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().max(200),
      knowledgeBaseEnabled: Joi.boolean(),
      description: Joi.string().trim().max(2000).allow(''),
    })
    .min(1)
    .required(),
};

const getVoiceAgent = {
  params: Joi.object().keys({
    agentId: Joi.string().required().trim(),
  }),
};

const kbQuery = {
  body: Joi.object()
    .keys({
      agentId: Joi.string().required().trim(),
      query: Joi.string().required().trim().max(4000),
      includeSources: Joi.boolean(),
    })
    .required(),
};

const kbTextIngest = {
  params: Joi.object().keys({
    agentId: Joi.string().required().trim(),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().trim().max(500).allow(''),
      text: Joi.string().required().trim().max(5000000),
    })
    .required(),
};

const kbUrlIngest = {
  params: Joi.object().keys({
    agentId: Joi.string().required().trim(),
  }),
  body: Joi.object()
    .keys({
      url: Joi.string().uri().required().trim().max(4000).messages({
        'string.uri': 'URL must be a valid URL',
      }),
    })
    .required(),
};

const kbListDocs = {
  params: Joi.object().keys({
    agentId: Joi.string().required().trim(),
  }),
};

const kbPdfIngest = {
  params: Joi.object().keys({
    agentId: Joi.string().required().trim(),
  }),
};

const kbDeleteDoc = {
  params: Joi.object().keys({
    documentId: Joi.string().custom(objectId).required(),
  }),
};

export {
  createVoiceAgent,
  updateVoiceAgent,
  getVoiceAgent,
  kbQuery,
  kbTextIngest,
  kbUrlIngest,
  kbListDocs,
  kbPdfIngest,
  kbDeleteDoc,
};
