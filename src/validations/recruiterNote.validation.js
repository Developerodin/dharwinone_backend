import Joi from 'joi';
import { objectId } from './custom.validation.js';

const listNotes = {
  params: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    limit: Joi.number().integer().min(1).max(500).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

const createNote = {
  params: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    note: Joi.string().trim().min(1).max(5000).required(),
    visibility: Joi.string().valid('public', 'private').optional(),
  }),
};

const deleteNote = {
  params: Joi.object().keys({
    noteId: Joi.string().custom(objectId).required(),
  }),
};

const shareByEmail = {
  params: Joi.object().keys({
    recruiterId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    email: Joi.string().email().required(),
    message: Joi.string().trim().max(1000).optional().allow('', null),
  }),
};

export { listNotes, createNote, deleteNote, shareByEmail };
