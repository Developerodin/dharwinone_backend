import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createTeamGroup = {
  body: Joi.object()
    .keys({
      name: Joi.string().required().trim(),
    })
    .required(),
};

const getTeamGroups = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional(),
    page: Joi.number().integer().optional(),
  }),
};

const getTeamGroup = {
  params: Joi.object()
    .keys({
      teamGroupId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

const updateTeamGroup = {
  params: Joi.object()
    .keys({
      teamGroupId: Joi.string().custom(objectId).required(),
    })
    .required(),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim(),
    })
    .min(1),
};

const deleteTeamGroup = {
  params: Joi.object()
    .keys({
      teamGroupId: Joi.string().custom(objectId).required(),
    })
    .required(),
};

export {
  createTeamGroup,
  getTeamGroups,
  getTeamGroup,
  updateTeamGroup,
  deleteTeamGroup,
};
