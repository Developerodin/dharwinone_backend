import Joi from 'joi';

const hostSchema = Joi.object({
  nameOrRole: Joi.string().allow('', null).trim(),
  email: Joi.string().trim().email().required(),
});

// Recurrence rule for a recurring series. Present (with frequency) => series path.
const recurrenceSchema = Joi.object({
  frequency: Joi.string().valid('daily', 'weekly', 'monthly', 'custom').required(),
  interval: Joi.number().integer().min(1).max(365).default(1),
  daysOfWeek: Joi.array().items(Joi.number().integer().min(0).max(6)).default([]), // 0=Sun..6=Sat
  dayOfMonth: Joi.number().integer().min(1).max(31).allow(null),
});

// Partial recurrence for edits (frequency optional).
const recurrenceUpdateSchema = Joi.object({
  frequency: Joi.string().valid('daily', 'weekly', 'monthly', 'custom'),
  interval: Joi.number().integer().min(1).max(365),
  daysOfWeek: Joi.array().items(Joi.number().integer().min(0).max(6)),
  dayOfMonth: Joi.number().integer().min(1).max(31).allow(null),
});

const endSchema = Joi.object({
  mode: Joi.string().valid('never', 'onDate', 'afterCount').default('never'),
  untilDate: Joi.date().allow(null),
  count: Joi.number().integer().min(1).max(1000).allow(null),
});

// ?mode= for series edit/cancel scope.
const seriesModeQuery = Joi.object().keys({
  mode: Joi.string().valid('single', 'future', 'series').default('single'),
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
      // Recurring series (optional). scheduledAt doubles as the series startAt.
      recurrence: recurrenceSchema.optional(),
      end: endSchema.optional(),
    })
    .min(1),
};

const getInternalMeetings = {
  query: Joi.object().keys({
    title: Joi.string().trim(),
    status: Joi.string().valid('scheduled', 'ended', 'cancelled'),
    sortBy: Joi.string().default('-createdAt'),
    limit: Joi.number().integer().min(1).max(500).default(10),
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
  query: seriesModeQuery,
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
      // Series rule edits (only honored when the target meeting belongs to a series).
      recurrence: recurrenceUpdateSchema.optional(),
      end: endSchema.optional(),
    })
    .min(1),
};

const deleteInternalMeeting = {
  params: Joi.object().keys({
    // Mongo _id or LiveKit meetingId (meeting_…) — resolved in the service layer.
    id: Joi.string().required().trim().min(1),
  }),
  query: seriesModeQuery.keys({
    purge: Joi.boolean().truthy('true').falsy('false').default(false),
  }),
};

const resendInternalInvitations = {
  params: Joi.object().keys({
    id: Joi.string().required().trim().min(1),
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
