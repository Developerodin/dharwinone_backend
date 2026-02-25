import Joi from 'joi';
import { objectId } from './custom.validation.js';

const submitEssayAttempt = {
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
            typedAnswer: Joi.string().allow('').optional(),
          })
        )
        .required(),
      timeSpent: Joi.number().integer().min(0).optional(),
    })
    .required(),
};

export { submitEssayAttempt };
