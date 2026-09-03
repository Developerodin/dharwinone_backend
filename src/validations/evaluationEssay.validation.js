import Joi from 'joi';
import { objectId } from './custom.validation.js';

export const listStudentEssayAttempts = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
};

export const gradeEssayAttempt = {
  params: Joi.object().keys({
    attemptId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      answers: Joi.array()
        .items(
          Joi.object({
            questionIndex: Joi.number().integer().min(0).required(),
            score: Joi.number().min(0).required(),
            feedback: Joi.string().allow('').max(1000).optional(),
          })
        )
        .min(1)
        .required(),
      feedback: Joi.string().allow('').max(2000).optional(),
    })
    .required(),
};
