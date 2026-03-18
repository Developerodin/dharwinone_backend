import Joi from 'joi';

const MAX_PREFIX_LEN = 500;
const MAX_KEY_LEN = 1024;
const MAX_NEXT_LEN = 1024;

const TRAVERSAL_PATTERN = /(\.\.|%2e%2e|%2f\.\.|\.\.%2f|\\)/i;

const list = {
  query: Joi.object().keys({
    prefix: Joi.string()
      .max(MAX_PREFIX_LEN)
      .regex(TRAVERSAL_PATTERN, { invert: true })
      .allow('')
      .default('')
      .messages({ 'string.pattern.invert.base': '"prefix" must not contain path traversal sequences' }),
    next: Joi.string().max(MAX_NEXT_LEN).allow('').optional(),
    maxKeys: Joi.number().integer().min(1).max(1000).optional(),
  }),
};

const upload = {
  body: Joi.object().keys({
    folder: Joi.string()
      .max(MAX_PREFIX_LEN)
      .regex(TRAVERSAL_PATTERN, { invert: true })
      .allow('')
      .optional()
      .messages({ 'string.pattern.invert.base': '"folder" must not contain path traversal sequences' }),
  }),
};

const getDownload = {
  query: Joi.object().keys({
    key: Joi.string().required().max(MAX_KEY_LEN),
  }),
};

const deleteObject = {
  query: Joi.object().keys({
    key: Joi.string().required().max(MAX_KEY_LEN),
  }),
};

const createFolder = {
  body: Joi.object().keys({
    name: Joi.string()
      .required()
      .max(200)
      .regex(TRAVERSAL_PATTERN, { invert: true })
      .messages({ 'string.pattern.invert.base': '"name" must not contain path traversal sequences' }),
    prefix: Joi.string()
      .max(MAX_PREFIX_LEN)
      .regex(TRAVERSAL_PATTERN, { invert: true })
      .allow('')
      .optional()
      .messages({ 'string.pattern.invert.base': '"prefix" must not contain path traversal sequences' }),
  }),
};

export { list, upload, getDownload, deleteObject, createFolder };
