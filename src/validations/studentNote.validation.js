import Joi from 'joi';
import { objectId } from './custom.validation.js';

const listNotes = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId).required(),
  }),
};

const createNote = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      note: Joi.string().trim().min(1).max(5000).required(),
      visibility: Joi.string().valid('public', 'private').default('public'),
    })
    .required(),
};

const deleteNote = {
  params: Joi.object().keys({
    noteId: Joi.string().custom(objectId).required(),
  }),
};

export { listNotes, createNote, deleteNote };
