import Joi from 'joi';
import { password, objectId } from './custom.validation.js';

const notificationPreferencesSchema = Joi.object({
  leaveUpdates: Joi.boolean(),
  taskAssignments: Joi.boolean(),
  applicationUpdates: Joi.boolean(),
  offerUpdates: Joi.boolean(),
  meetingInvitations: Joi.boolean(),
  meetingReminders: Joi.boolean(),
  certificates: Joi.boolean(),
  courseUpdates: Joi.boolean(),
  recruiterUpdates: Joi.boolean(),
});

const register = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    isEmailVerified: Joi.boolean().optional(),
    roleIds: Joi.array().items(Joi.string().custom(objectId)).optional(),
    // Dharwrin-style candidate registration from invite link
    role: Joi.string().valid('user', 'admin', 'supervisor', 'recruiter').optional(),
    phoneNumber: Joi.string().allow('').optional(),
    countryCode: Joi.string().allow('').optional(),
    /** Applied to linked Candidate after admin creates user (optional). */
    employeeId: Joi.string().trim().allow('').optional(),
    shortBio: Joi.string().trim().allow('').optional().max(10000),
    joiningDate: Joi.date().optional().allow(null, ''),
    department: Joi.string().trim().allow('').optional().max(500),
    designation: Joi.string().trim().allow('').optional().max(500),
    degree: Joi.string().trim().allow('').optional().max(500),
    salaryRange: Joi.string().trim().allow('').optional().max(500),
    /** Only honored for authenticated administrators; others are stripped in controller. */
    status: Joi.string().valid('active', 'pending').optional(),
    adminId: Joi.when('role', {
      is: 'user',
      then: Joi.string().custom(objectId),
      otherwise: Joi.optional(),
    }),
  }),
};

/** Public candidate onboarding: creates User (pending) + Candidate so they appear in ATS list. */
const registerCandidate = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    phoneNumber: Joi.string().allow('').optional(),
    /** ISO 3166-1 alpha-2, e.g. US, IN — stored on User + Candidate so profile shows correct dial code */
    countryCode: Joi.string().length(2).uppercase().optional().allow(''),
    /** HMAC v1 ref= token from tracked referral link */
    ref: Joi.string().trim().allow('').optional(),
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

const sendCandidateInvitation = {
  body: Joi.alternatives()
    .try(
      Joi.object().keys({
        email: Joi.string().email().required(),
        onboardUrl: Joi.string().uri().required(),
      }),
      Joi.object().keys({
        invitations: Joi.array()
          .items(
            Joi.object().keys({
              email: Joi.string().email().required(),
              onboardUrl: Joi.string().uri().required(),
            })
          )
          .min(1)
          .max(50)
          .required()
          .messages({
            'array.min': 'At least one invitation is required',
            'array.max': 'Maximum 50 invitations can be sent at once',
          }),
      })
    )
    .messages({
      'alternatives.match': 'Request body must contain either single invitation (email, onboardUrl) or bulk invitations (invitations array)',
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
  }),
};

const registerRecruiter = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    name: Joi.string().required(),
    phoneNumber: Joi.string().optional().allow('', null),
    countryCode: Joi.string().optional().allow('', null),
    education: Joi.string().optional().allow('', null),
    domain: Joi.alternatives().try(Joi.string(), Joi.array().items(Joi.string())).optional(),
    location: Joi.string().optional().allow('', null),
    profileSummary: Joi.string().optional().allow('', null),
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
  }),
};

/** Self-profile update: name, notificationPreferences, profilePicture, and User profile fields. No email. */
const updateMe = {
  body: Joi.object()
    .keys({
      name: Joi.string().min(1).trim(),
      notificationPreferences: notificationPreferencesSchema,
      profilePicture: Joi.object({
        url: Joi.string().uri().optional(),
        key: Joi.string().optional().trim(),
        originalName: Joi.string().optional().trim(),
        size: Joi.number().optional().integer().min(0),
        mimeType: Joi.string().optional().trim(),
      })
        .optional()
        .allow(null),
      phoneNumber: Joi.string().trim().allow('').optional(),
      countryCode: Joi.string().trim().allow('').optional(),
      education: Joi.string().trim().allow('').optional().max(2000),
      domain: Joi.array().items(Joi.string().trim().max(200)).max(50).optional(),
      location: Joi.string().trim().allow('').optional().max(1000),
      profileSummary: Joi.string().trim().allow('').optional().max(10000),
    })
    .min(1),
};

/** Combined User + Candidate self-update for PATCH /auth/me/with-candidate. */
const updateMeWithCandidate = {
  body: Joi.object()
    .keys({
      // User fields
      name: Joi.string().min(1).trim(),
      notificationPreferences: notificationPreferencesSchema,
      profilePicture: Joi.object({
        url: Joi.string().uri().optional(),
        key: Joi.string().optional().trim(),
        originalName: Joi.string().optional().trim(),
        size: Joi.number().optional().integer().min(0),
        mimeType: Joi.string().optional().trim(),
      })
        .optional()
        .allow(null),
      // Employee profile fields (from employee.validation updateCandidate)
      fullName: Joi.string().trim(),
      email: Joi.string().email(),
      phoneNumber: Joi.string()
        .pattern(/^\d{6,15}$/)
        .messages({ 'string.pattern.base': 'Phone number must be 6-15 digits' }),
      shortBio: Joi.string().allow('', null),
      sevisId: Joi.string().allow('', null),
      ead: Joi.string().allow('', null),
      visaType: Joi.string().optional().trim(),
      customVisaType: Joi.string().allow('', null),
      countryCode: Joi.string().allow('', null),
      degree: Joi.string().allow('', null),
      supervisorName: Joi.string().allow('', null),
      supervisorContact: Joi.string().allow('', null),
      supervisorCountryCode: Joi.string().allow('', null),
      salaryRange: Joi.string().optional().trim(),
      address: Joi.object({
        streetAddress: Joi.string().optional().trim(),
        streetAddress2: Joi.string().allow('', null),
        city: Joi.string().optional().trim(),
        state: Joi.string().optional().trim(),
        zipCode: Joi.string().optional().trim(),
        country: Joi.string().optional().trim(),
      }).optional(),
      qualifications: Joi.array().items(
        Joi.object({
          degree: Joi.string().required(),
          institute: Joi.string().required(),
          location: Joi.string().allow('', null),
          startYear: Joi.number().integer().min(1900).max(3000).allow(null),
          endYear: Joi.number().integer().min(1900).max(3000).allow(null),
          description: Joi.string().allow('', null),
        })
      ),
      experiences: Joi.array().items(
        Joi.object({
          company: Joi.string().required(),
          role: Joi.string().required(),
          startDate: Joi.date().allow(null),
          endDate: Joi.date().allow(null),
          currentlyWorking: Joi.boolean().default(false),
          description: Joi.string().allow('', null),
        })
      ),
      documents: Joi.array().items(
        Joi.object({
          type: Joi.string().valid('Aadhar', 'PAN', 'Bank', 'Passport', 'Other').optional().default('Other'),
          label: Joi.string().optional().trim(),
          url: Joi.string().trim().optional().allow(''),
          key: Joi.string().optional().trim(),
          originalName: Joi.string().optional().trim(),
          size: Joi.number().optional().integer().min(0),
          mimeType: Joi.string().optional().trim(),
          status: Joi.number().optional().integer().default(0),
        })
      ),
      skills: Joi.array().items(
        Joi.object({
          name: Joi.string().required(),
          level: Joi.string().valid('Beginner', 'Intermediate', 'Advanced', 'Expert').default('Beginner'),
          category: Joi.string().allow('', null),
        })
      ),
      socialLinks: Joi.array().items(
        Joi.object({
          platform: Joi.string().required(),
          url: Joi.string().uri().required(),
        })
      ),
      salarySlips: Joi.array().items(
        Joi.object({
          month: Joi.string().optional().trim(),
          year: Joi.number().integer().min(1900).max(2100).optional(),
          documentUrl: Joi.string().trim().optional().allow(''),
          key: Joi.string().optional().trim(),
          originalName: Joi.string().optional().trim(),
          size: Joi.number().optional().integer().min(0),
          mimeType: Joi.string().optional().trim(),
        })
      ),
    })
    .min(1),
};

export {
  register,
  registerCandidate,
  registerRecruiter,
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
  sendCandidateInvitation,
  updateMe,
  updateMeWithCandidate,
};

