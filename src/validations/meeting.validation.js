import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { normalizeTimezone, isValidTimezone } from '../utils/timezone.js';
import { INTERVIEW_STATUSES, INTERVIEW_RESULTS } from '../constants/atsPipeline.js';

const hostSchema = Joi.object({
  nameOrRole: Joi.string().allow('', null).trim(),
  email: Joi.string().trim().email().required(),
});

// B9 fix: when an id is supplied it must be a 24-hex MongoDB ObjectId.
// Empty string / null are still allowed for "no candidate selected" / "no recruiter selected".
// Previously any free-form string passed (e.g. mock id "1"), which silently broke downstream
// JobApplication.updateOne() (the candidate→Interview transition) and recruiter activity logging.
const optionalRefId = Joi.string()
  .trim()
  .allow('', null)
  .max(128)
  .pattern(/^[0-9a-fA-F]{24}$/, { name: 'objectId' })
  .messages({ 'string.pattern.name': 'must be a valid 24-character hex MongoDB id' });

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

const agentRefSchema = Joi.object({
  id: optionalRefId,
  name: Joi.string().allow('', null).trim(),
  email: Joi.string().email().allow('', null),
});

/**
 * Accepts blank (model default applies) or any IANA zone. Legacy aliases are
 * normalized before validation so old clients are not rejected.
 */
const timezoneField = Joi.string()
  .allow('', null)
  .trim()
  .custom((value, helpers) => {
    if (value === '' || value == null) return value;
    const normalized = normalizeTimezone(value);
    if (!isValidTimezone(normalized)) return helpers.error('any.invalid');
    return normalized;
  }, 'IANA timezone')
  .messages({ 'any.invalid': 'timezone must be a valid IANA zone' });

const createMeeting = {
  body: Joi.object()
    .keys({
      title: Joi.string().required().trim(),
      description: Joi.string().allow('', null).trim(),
      scheduledAt: Joi.date().required(),
      timezone: timezoneField,
      agents: Joi.array().items(agentRefSchema).default([]),
      durationMinutes: Joi.number().integer().min(1).max(480).default(60),
      maxParticipants: Joi.number().integer().min(1).max(100).default(10),
      allowGuestJoin: Joi.boolean().default(false), // invite-only by default; opt in to open the link to anyone
      requireApproval: Joi.boolean().default(false),
      hosts: Joi.array().items(hostSchema).min(1).required().messages({
        'array.min': 'At least one host with email is required',
      }),
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
    status: Joi.string().valid(...INTERVIEW_STATUSES),
    sortBy: Joi.string().default('-createdAt'),
    limit: Joi.number().integer().min(1).max(100).default(10),
    page: Joi.number().integer().min(1).default(1),
  }),
};

// id can be MongoDB ObjectId or meetingId string (e.g. meeting_xxx)
const getMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().trim().min(1),
  }),
};

// id can be MongoDB ObjectId or meetingId string (e.g. meeting_xxx)
const updateMeeting = {
  params: Joi.object().keys({
    id: Joi.string().required().trim().min(1),
  }),
  body: Joi.object()
    .keys({
      title: Joi.string().trim(),
      description: Joi.string().allow('', null).trim(),
      scheduledAt: Joi.date(),
      timezone: timezoneField,
      agents: Joi.array().items(agentRefSchema),
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
      status: Joi.string().valid(...INTERVIEW_STATUSES),
      interviewResult: Joi.string().valid(...INTERVIEW_RESULTS),
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

// Public: end meeting when host leaves (body: roomName, hostEmail)
const endMeetingByRoomPublic = {
  body: Joi.object()
    .keys({
      roomName: Joi.string().required().trim(),
      // Ignored by the controller (host identity from the authenticated session);
      // optional only for backward-compatible clients that still send it.
      hostEmail: Joi.string().email().optional(),
    })
    .required(),
};

export {
  createMeeting,
  getMeetings,
  getMeeting,
  getMeetingRecordings,
  updateMeeting,
  deleteMeeting,
  resendInvitations,
  endMeetingByRoomPublic,
};
