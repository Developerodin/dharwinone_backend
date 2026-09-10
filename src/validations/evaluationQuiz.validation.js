import Joi from 'joi';
import { objectId } from './custom.validation.js';

export const listStudentQuizAttempts = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
};

export const gradeQuizAttempt = {
  params: Joi.object().keys({
    attemptId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      feedback: Joi.string().allow('').max(2000).optional(),
    })
    .required(),
};
