import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getStudents = {
  query: Joi.object().keys({
    status: Joi.string().valid('active', 'inactive'),
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId),
  }),
};

const updateStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      phone: Joi.string().optional().allow('', null),
      dateOfBirth: Joi.date().optional().allow(null),
      gender: Joi.string().valid('male', 'female', 'other').optional().allow(null),
      address: Joi.object({
        street: Joi.string().optional().allow('', null),
        city: Joi.string().optional().allow('', null),
        state: Joi.string().optional().allow('', null),
        zipCode: Joi.string().optional().allow('', null),
        country: Joi.string().optional().allow('', null),
      }).optional(),
      education: Joi.array().items(
        Joi.object({
          degree: Joi.string().optional().allow('', null),
          institution: Joi.string().optional().allow('', null),
          fieldOfStudy: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      ).optional(),
      experience: Joi.array().items(
        Joi.object({
          title: Joi.string().optional().allow('', null),
          company: Joi.string().optional().allow('', null),
          location: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      ).optional(),
      skills: Joi.array().items(Joi.string()).optional(),
      documents: Joi.array().items(
        Joi.object({
          name: Joi.string().required(),
          type: Joi.string().required(),
          fileUrl: Joi.string().optional().allow('', null),
          fileKey: Joi.string().optional().allow('', null),
        })
      ).optional(),
      bio: Joi.string().optional().allow('', null),
      profileImageUrl: Joi.string().optional().allow('', null),
      status: Joi.string().valid('active', 'inactive').optional(),
    })
    .min(1),
};

const deleteStudent = {
  params: Joi.object().keys({
    studentId: Joi.string().custom(objectId),
  }),
};

export { getStudents, getStudent, updateStudent, deleteStudent };
