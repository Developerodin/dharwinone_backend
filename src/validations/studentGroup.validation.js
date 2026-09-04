import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createStudentGroup = {
  body: Joi.object().keys({
    name: Joi.string().required().trim().min(1).max(200),
    description: Joi.string().optional().trim().max(1000).allow('', null),
    studentIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
  }),
};

const updateStudentGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().optional().trim().min(1).max(200),
      description: Joi.string().optional().trim().max(1000).allow('', null),
      studentIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
      isActive: Joi.boolean().optional(),
    })
    .min(1),
};

const getStudentGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
};

const getGroupStudents = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
  }),
};

const getStudentGroups = {
  query: Joi.object().keys({
    name: Joi.string().optional().trim(),
    isActive: Joi.boolean().optional(),
    createdBy: Joi.string().custom(objectId).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

const addStudentsToGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    studentIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
  }),
};

const removeStudentsFromGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    studentIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
  }),
};

const assignHolidaysToGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    holidayIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
  }),
};

const removeHolidaysFromGroup = {
  params: Joi.object().keys({
    groupId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    holidayIds: Joi.array().items(Joi.string().custom(objectId)).min(1).required(),
  }),
};

export {
  createStudentGroup,
  updateStudentGroup,
  getStudentGroup,
  getGroupStudents,
  getStudentGroups,
  addStudentsToGroup,
  removeStudentsFromGroup,
  assignHolidaysToGroup,
  removeHolidaysFromGroup,
};
