import Joi from 'joi';
import { objectId } from './custom.validation.js';

const hostSchema = Joi.object({
  nameOrRole: Joi.string().allow('', null).trim(),
  email: Joi.string().email().required(),
});

// id can be a MongoDB ObjectId or any string (e.g. mock/legacy ids from dropdowns)
const optionalRefId = Joi.string().trim().allow('', null).max(128);

const candidateRefSchema = Joi.object({
  id: optionalRefId,
  name: Joi.string().allow('', null).trim(),
  email: Joi.string().email().allow('', null),
  phone: Joi.string().allow('', null).trim(),
});

const recruiterRefSchema = Joi.object({
  id: optionalRefId,
  name: Joi.string().allow('', null).trim(),
  email: Joi.string().email().allow('', null),
});

const createMeeting = {
  body: Joi.object()
    .keys({
      title: Joi.string().required().trim(),
      description: Joi.string().allow('', null).trim(),
      scheduledAt: Joi.date().required(),
      timezone: Joi.string().allow('', null).trim(),
      durationMinutes: Joi.number().integer().min(1).max(480).default(60),
      maxParticipants: Joi.number().integer().min(1).max(100).default(10),
      allowGuestJoin: Joi.boolean().default(true),
      requireApproval: Joi.boolean().default(false),
      hosts: Joi.array().items(hostSchema).default([]),
      emailInvites: Joi.array().items(Joi.string().email()).default([]),
      jobPosition: Joi.string().allow('', null).trim(),
      interviewType: Joi.string().valid('Video', 'In-Person', 'Phone').default('Video'),
      candidate: candidateRefSchema.allow(null),
      recruiter: recruiterRefSchema.allow(null),
      notes: Joi.string().allow('', null).trim(),
    })
    .min(1),
};

const getMeetings = {
  query: Joi.object().keys({
    title: Joi.string().trim(),
    status: Joi.string().valid('scheduled', 'ended', 'cancelled'),
    sortBy: Joi.string().default('-createdAt'),
    limit: Joi.number().integer().min(1).max(100).default(10),
    page: Joi.number().integer().min(1).default(1),
  }),
};

const getMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const updateMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
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
      hosts: Joi.array().items(hostSchema),
      emailInvites: Joi.array().items(Joi.string().email()),
      jobPosition: Joi.string().allow('', null).trim(),
      interviewType: Joi.string().valid('Video', 'In-Person', 'Phone'),
      candidate: candidateRefSchema.allow(null),
      recruiter: recruiterRefSchema.allow(null),
      notes: Joi.string().allow('', null).trim(),
      status: Joi.string().valid('scheduled', 'ended', 'cancelled'),
    })
    .min(1),
};

const deleteMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const resendInvitations = {
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

// id can be meetingId string or MongoDB ObjectId
const getMeetingRecordings = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
};

export {
  createMeeting,
  getMeetings,
  getMeeting,
  getMeetingRecordings,
  updateMeeting,
  deleteMeeting,
  resendInvitations,
};
