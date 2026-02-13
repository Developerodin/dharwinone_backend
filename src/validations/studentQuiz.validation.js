import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getQuiz = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
    playlistItemId: Joi.string().required(),
  }),
};

const submitQuizAttempt = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
    playlistItemId: Joi.string().required(),
  }),
  body: Joi.object()
    .keys({
      answers: Joi.array()
        .items(
          Joi.object({
            questionIndex: Joi.number().integer().min(0).required(),
            selectedOptions: Joi.array().items(Joi.number().integer().min(0)).required(),
          })
        )
        .required(),
      timeSpent: Joi.number().integer().min(0).optional(),
    })
    .required(),
};

const getQuizAttemptHistory = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
    playlistItemId: Joi.string().required(),
  }),
};

const getQuizResults = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
    playlistItemId: Joi.string().required(),
  }),
};

export { getQuiz, submitQuizAttempt, getQuizAttemptHistory, getQuizResults };
