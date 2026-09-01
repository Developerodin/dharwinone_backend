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

const meetingFilterQueryKeys = {
  title: Joi.string().trim().allow(''),
  /** Comma-separated status values (matches Interviews filter panel). */
  status: Joi.string().trim().allow(''),
  /** Comma-separated candidate display names — substring match on candidate.name. */
  candidate: Joi.string().trim().allow(''),
  /** Comma-separated recruiter display names — substring match on recruiter.name. */
  recruiter: Joi.string().trim().allow(''),
  /** Comma-separated interview types (Video, In-Person, Phone). */
  interviewType: Joi.string().trim().allow(''),
  /**
   * Optional scheduledAt window, as ISO INSTANTS (not calendar days) — the caller
   * resolves its own local day to UTC before sending. Omitted => unchanged behaviour
   * for every existing consumer.
   */
  dateFrom: Joi.date().iso(),
  /* Ordering is checked in boundedDateRange, not with Joi.ref('dateFrom') — an
     unresolvable ref makes a dateTo-only query fail, and either bound alone is valid. */
  dateTo: Joi.date().iso(),
  sortBy: Joi.string(),
  limit: Joi.number().integer().min(1).max(100),
  page: Joi.number().integer().min(1),
};

/**
 * Widest scheduledAt window a caller may request, in days. A dashboard asks for one
 * day; an operator filtering the Interviews table asks for weeks. An unbounded range
 * (dateFrom=1970 & dateTo=2099) is a full-collection scan wearing a filter, so it is
 * refused rather than served slowly.
 */
const MAX_MEETING_DATE_RANGE_DAYS = 92;

/**
 * Order and width of the scheduledAt window. Only applies when BOTH bounds are present —
 * either one alone is a valid open-ended window.
 */
const boundedDateRange = (value, helpers) => {
  const { dateFrom, dateTo } = value;
  if (!dateFrom || !dateTo) return value;
  const spanMs = new Date(dateTo).getTime() - new Date(dateFrom).getTime();
  if (spanMs < 0) {
    return helpers.error('any.invalid', { message: 'dateTo must not precede dateFrom' });
  }
  if (spanMs / 86400000 > MAX_MEETING_DATE_RANGE_DAYS) {
    return helpers.error('any.invalid', {
      message: `dateFrom..dateTo must span at most ${MAX_MEETING_DATE_RANGE_DAYS} days`,
    });
  }
  return value;
};

const getMeetings = {
  query: Joi.object()
    .keys({
      ...meetingFilterQueryKeys,
      sortBy: meetingFilterQueryKeys.sortBy.default('-createdAt'),
      limit: meetingFilterQueryKeys.limit.default(10),
      page: meetingFilterQueryKeys.page.default(1),
    })
    .custom(boundedDateRange, 'bounded scheduledAt range'),
};

const getMyInterviews = {
  query: Joi.object().keys({
    sortBy: Joi.string().default('scheduledAt:asc'),
    limit: Joi.number().integer().min(1).max(50).default(20),
    page: Joi.number().integer().min(1).default(1),
  }),
};

const exportMeetings = {
  query: Joi.object()
    .keys(
      Object.fromEntries(
        Object.entries(meetingFilterQueryKeys).filter(([key]) => !['page', 'limit'].includes(key))
      )
    )
    .custom(boundedDateRange, 'bounded scheduledAt range'),
  body: Joi.object()
    .keys({
      ids: Joi.array()
        .items(Joi.string().pattern(/^[0-9a-fA-F]{24}$/))
        .optional(),
    })
    .optional(),
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

// Internal employee transfer (post-interview). id = ObjectId or meeting_xxx; body optional overrides.
const internalTransfer = {
  params: Joi.object().keys({
    id: Joi.string().required().trim().min(1),
  }),
  body: Joi.object().keys({
    designation: Joi.string().trim().allow('', null),
    departmentId: Joi.string().custom(objectId).allow(null),
    effectiveDate: Joi.date().allow(null),
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
  getMyInterviews,
  exportMeetings,
  getMeeting,
  getMeetingRecordings,
  updateMeeting,
  deleteMeeting,
  resendInvitations,
  endMeetingByRoomPublic,
  internalTransfer,
};
