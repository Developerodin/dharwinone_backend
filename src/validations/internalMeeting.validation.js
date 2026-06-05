import Joi from 'joi';
import { objectId } from './custom.validation.js';

const hostSchema = Joi.object({
  nameOrRole: Joi.string().allow('', null).trim(),
  email: Joi.string().trim().email().required(),
});

const createInternalMeeting = {
  body: Joi.object()
    .keys({
      title: Joi.string().required().trim(),
      description: Joi.string().allow('', null).trim(),
      scheduledAt: Joi.date().required(),
      timezone: Joi.string().allow('', null).trim(),
      durationMinutes: Joi.number().integer().min(1).max(480).default(60),
      maxParticipants: Joi.number().integer().min(1).max(100).default(10),
      allowGuestJoin: Joi.boolean().default(false), // invite-only by default; opt in to open the link to anyone
      requireApproval: Joi.boolean().default(false),
      meetingType: Joi.string().valid('Video', 'In-Person', 'Phone').default('Video'),
      hosts: Joi.array().items(hostSchema).min(1).required().messages({
        'array.min': 'At least one host with email is required',
      }),
      emailInvites: Joi.array().items(Joi.string().email()).default([]),
      notes: Joi.string().allow('', null).trim(),
    })
    .min(1),
};

const getInternalMeetings = {
  query: Joi.object().keys({
    title: Joi.string().trim(),
    status: Joi.string().valid('scheduled', 'ended', 'cancelled'),
    sortBy: Joi.string().default('-createdAt'),
    limit: Joi.number().integer().min(1).max(100).default(10),
    page: Joi.number().integer().min(1).default(1),
  }),
};

const getInternalMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().trim().min(1),
  }),
};

const updateInternalMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().trim().min(1),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().trim(),
      description: Joi.string().allow('', null).trim(),
      scheduledAt: Joi.date(),
      timezone: Joi.string().allow('', null).trim(),
      durationMinutes: Joi.number().integer().min(1).max(480),
      maxParticipants: Joi.number().integer().min(1).max(100),
      allowGuestJoin: Joi.boolean(),
      requireApproval: Joi.boolean(),
      meetingType: Joi.string().valid('Video', 'In-Person', 'Phone'),
      hosts: Joi.array().items(hostSchema),
      emailInvites: Joi.array().items(Joi.string().email()),
      notes: Joi.string().allow('', null).trim(),
      status: Joi.string().valid('scheduled', 'ended', 'cancelled'),
    })
    .min(1),
};

const deleteInternalMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const resendInternalInvitations = {
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getInternalMeetingRecordings = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
};

export {
  createInternalMeeting,
  getInternalMeetings,
  getInternalMeeting,
  updateInternalMeeting,
  deleteInternalMeeting,
  resendInternalInvitations,
  getInternalMeetingRecordings,
};
