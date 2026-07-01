import Joi from 'joi';
import { objectId } from './custom.validation.js';

const phone = Joi.object().keys({
  label: Joi.string().valid('work', 'mobile', 'other'),
  number: Joi.string().trim().required(),
  isPrimary: Joi.boolean(),
});

const linkedTo = Joi.object().keys({
  type: Joi.string().valid('candidate', 'employee', 'user').required(),
  id: Joi.string().custom(objectId).required(),
}).allow(null);

const bodyBase = {
  name: Joi.string().trim().min(1).max(200),
  phones: Joi.array().items(phone).min(1),
  company: Joi.string().trim().allow('').max(200),
  email: Joi.string().trim().allow('').max(200),
  notes: Joi.string().trim().allow('').max(5000),
  tags: Joi.array().items(Joi.string().trim()),
  favorite: Joi.boolean(),
  doNotCall: Joi.boolean(),
  source: Joi.string().valid('manual', 'from_call', 'imported'),
  sourceCallId: Joi.string().custom(objectId).allow(null),
  linkedTo,
};

export const createContact = {
  body: Joi.object().keys({
    ...bodyBase,
    name: bodyBase.name.required(),
    phones: bodyBase.phones.required(),
    autoSuggestLink: Joi.boolean(),
  }).required(),
};

export const getContacts = {
  query: Joi.object().keys({
    q: Joi.string().allow(''), sortBy: Joi.string(),
    limit: Joi.number().integer().min(1).max(100), page: Joi.number().integer().min(1),
    favorite: Joi.boolean(),
  }),
};

export const getContact = { params: Joi.object().keys({ contactId: Joi.string().custom(objectId).required() }) };
export const deleteContact = getContact;
export const updateContact = {
  params: getContact.params,
  body: Joi.object().keys(bodyBase).min(1),
};
