import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getMentors = {
  query: Joi.object().keys({
    status: Joi.string().valid('active', 'inactive'),
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getMentor = {
  params: Joi.object().keys({
    mentorId: Joi.string().custom(objectId),
  }),
};

const updateMentor = {
  params: Joi.object().keys({
    mentorId: Joi.string().required().custom(objectId),
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
      expertise: Joi.array().items(
        Joi.object({
          area: Joi.string().optional().allow('', null),
          level: Joi.string().optional().allow('', null),
          yearsOfExperience: Joi.number().optional().allow(null),
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
      certifications: Joi.array().items(
        Joi.object({
          name: Joi.string().required(),
          issuer: Joi.string().required(),
          issueDate: Joi.date().optional().allow(null),
          expiryDate: Joi.date().optional().allow(null),
          credentialId: Joi.string().optional().allow('', null),
          credentialUrl: Joi.string().optional().allow('', null),
        })
      ).optional(),
      skills: Joi.array().items(Joi.string()).optional(),
      bio: Joi.string().optional().allow('', null),
      profileImageUrl: Joi.string().optional().allow('', null),
      status: Joi.string().valid('active', 'inactive').optional(),
    })
    .min(1),
};

const deleteMentor = {
  params: Joi.object().keys({
    mentorId: Joi.string().custom(objectId),
  }),
};

export { getMentors, getMentor, updateMentor, deleteMentor };
