import Joi from 'joi';
import { password, objectId } from './custom.validation.js';


const createUser = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    role: Joi.string().required().valid('user', 'admin'),
    roleIds: Joi.array().items(Joi.string().custom(objectId)).default([]),
    status: Joi.string().valid('active', 'pending', 'disabled', 'deleted').default('active'),
  }),
};

const getUsers = {
  query: Joi.object().keys({
    name: Joi.string(),
    role: Joi.string(),
    status: Joi.string().valid('active', 'pending', 'disabled', 'deleted'),
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const updateUser = {
  params: Joi.object().keys({
    userId: Joi.required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      email: Joi.string().email(),
      password: Joi.string().custom(password),
      name: Joi.string(),
      roleIds: Joi.array().items(Joi.string().custom(objectId)),
      status: Joi.string().valid('active', 'pending', 'disabled', 'deleted'),
    })
    .min(1),
};

const deleteUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

export { createUser, getUsers, getUser, updateUser, deleteUser };

