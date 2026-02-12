import Joi from 'joi';
import { password, objectId } from './custom.validation.js';

const register = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    isEmailVerified: Joi.boolean().optional(),
    roleIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
  }),
};

const login = {
  body: Joi.object().keys({
    email: Joi.string().required(),
    password: Joi.string().required(),
  }),
};

const logout = {
  body: Joi.object()
    .keys({
      refreshToken: Joi.string().optional(),
    })
    .default({}),
};

const refreshTokens = {
  body: Joi.object()
    .keys({
      refreshToken: Joi.string().optional(),
    })
    .default({}),
};

const forgotPassword = {
  body: Joi.object().keys({
    email: Joi.string().email().required(),
  }),
};

const resetPassword = {
  query: Joi.object().keys({
    token: Joi.string().required(),
  }),
  body: Joi.object().keys({
    password: Joi.string().required().custom(password),
  }),
};

const changePassword = {
  body: Joi.object().keys({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().required().custom(password),
  }),
};

const verifyEmail = {
  query: Joi.object().keys({
    token: Joi.string().required(),
  }),
};

const impersonate = {
  body: Joi.object().keys({
    userId: Joi.string().required().custom(objectId),
  }),
};

const registerStudent = {
  body: Joi.object().keys({
    // User fields
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    // Student profile fields
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
    education: Joi.array()
      .items(
        Joi.object({
          degree: Joi.string().optional().allow('', null),
          institution: Joi.string().optional().allow('', null),
          fieldOfStudy: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      )
      .optional(),
    experience: Joi.array()
      .items(
        Joi.object({
          title: Joi.string().optional().allow('', null),
          company: Joi.string().optional().allow('', null),
          location: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      )
      .optional(),
    skills: Joi.array().items(Joi.string()).optional(),
    documents: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().required(),
          type: Joi.string().required(),
          fileUrl: Joi.string().optional().allow('', null),
          fileKey: Joi.string().optional().allow('', null),
        })
      )
      .optional(),
    bio: Joi.string().optional().allow('', null),
    profileImageUrl: Joi.string().optional().allow('', null),
  }),
};

const registerMentor = {
  body: Joi.object().keys({
    // User fields
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    // Mentor profile fields
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
    expertise: Joi.array()
      .items(
        Joi.object({
          area: Joi.string().optional().allow('', null),
          level: Joi.string().optional().allow('', null),
          yearsOfExperience: Joi.number().optional().allow(null),
          description: Joi.string().optional().allow('', null),
        })
      )
      .optional(),
    experience: Joi.array()
      .items(
        Joi.object({
          title: Joi.string().optional().allow('', null),
          company: Joi.string().optional().allow('', null),
          location: Joi.string().optional().allow('', null),
          startDate: Joi.date().optional().allow(null),
          endDate: Joi.date().optional().allow(null),
          isCurrent: Joi.boolean().optional(),
          description: Joi.string().optional().allow('', null),
        })
      )
      .optional(),
    certifications: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().required(),
          issuer: Joi.string().required(),
          issueDate: Joi.date().optional().allow(null),
          expiryDate: Joi.date().optional().allow(null),
          credentialId: Joi.string().optional().allow('', null),
          credentialUrl: Joi.string().optional().allow('', null),
        })
      )
      .optional(),
    skills: Joi.array().items(Joi.string()).optional(),
    bio: Joi.string().optional().allow('', null),
    profileImageUrl: Joi.string().optional().allow('', null),
  }),
};

export {
  register,
  registerStudent,
  registerMentor,
  login,
  logout,
  refreshTokens,
  forgotPassword,
  resetPassword,
  changePassword,
  verifyEmail,
  impersonate,
};
