import Joi from 'joi';

/**
 * `key` is NOT validated against an enum — the criteria are admin-defined and vary per
 * round. The service checks each key against the round's rubric snapshot and drops
 * anything unknown, which is the only check that can be correct here.
 *
 * `rating` accepts 0-10 because a criterion may declare its own scale; the service
 * clamps to that criterion's real bounds.
 *
 * `id` is a loose string because this route family already accepts either an ObjectId
 * or a `meeting_xxx` id — same as meetingValidation.getMeeting.
 */
const ratingSchema = Joi.object({
  key: Joi.string()
    .trim()
    .pattern(/^[a-zA-Z0-9_-]{1,40}$/)
    .required(),
  rating: Joi.number().integer().min(0).max(10).allow(null),
  notApplicable: Joi.boolean().default(false),
});

const saveEvaluation = {
  params: Joi.object().keys({ id: Joi.string().required() }),
  body: Joi.object().keys({
    ratings: Joi.array().items(ratingSchema).max(20).default([]),
    comment: Joi.string().trim().allow('', null).max(2000).default(''),
  }),
};

const getEvaluations = {
  params: Joi.object().keys({ id: Joi.string().required() }),
};

export default { saveEvaluation, getEvaluations };
