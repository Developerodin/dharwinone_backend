import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getStudentCourses = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    status: Joi.string().valid('enrolled', 'in-progress', 'completed', 'dropped'),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getStudentCourse = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
};

const startCourse = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
};

const markItemComplete = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      playlistItemId: Joi.string().required(),
      contentType: Joi.string()
        .valid('upload-video', 'youtube-link', 'pdf-document', 'blog', 'quiz', 'test')
        .required(),
    })
    .required(),
};

const updateLastAccessed = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      playlistItemId: Joi.string().required(),
    })
    .required(),
};

export { getStudentCourses, getStudentCourse, startCourse, markItemComplete, updateLastAccessed };
