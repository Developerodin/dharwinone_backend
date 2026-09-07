import Joi from 'joi';

// Keys mirror user.model.js notificationPreferences (email + *InApp variants).
// Shared by auth.validation (self update) and user.validation (admin update).
const notificationPreferencesSchema = Joi.object({
  leaveUpdates: Joi.boolean(),
  leaveUpdatesInApp: Joi.boolean(),
  taskAssignments: Joi.boolean(),
  taskAssignmentsInApp: Joi.boolean(),
  applicationUpdates: Joi.boolean(),
  applicationUpdatesInApp: Joi.boolean(),
  offerUpdates: Joi.boolean(),
  offerUpdatesInApp: Joi.boolean(),
  meetingInvitations: Joi.boolean(),
  meetingInvitationsInApp: Joi.boolean(),
  meetingReminders: Joi.boolean(),
  meetingRemindersInApp: Joi.boolean(),
  certificates: Joi.boolean(),
  certificatesInApp: Joi.boolean(),
  courseUpdates: Joi.boolean(),
  courseUpdatesInApp: Joi.boolean(),
  recruiterUpdates: Joi.boolean(),
  recruiterUpdatesInApp: Joi.boolean(),
  supportTicketUpdates: Joi.boolean(),
  supportTicketUpdatesInApp: Joi.boolean(),
  placementUpdates: Joi.boolean(),
  placementUpdatesInApp: Joi.boolean(),
  chatMessagesInApp: Joi.boolean(),
  assignmentUpdatesInApp: Joi.boolean(),
  projectUpdatesInApp: Joi.boolean(),
  sopAssignmentsInApp: Joi.boolean(),
});

const objectId = (value, helpers) => {
  if (!value.match(/^[0-9a-fA-F]{24}$/)) {
    return helpers.message('"{{#label}}" must be a valid mongo id');
  }
  return value;
};

/** Mongo ObjectId or human-readable dev ticket id (e.g. DEV-MRN8XTOF-19D0A8FC). */
const devTicketRef = (value, helpers) => {
  const trimmed = String(value).trim();
  if (trimmed.match(/^[0-9a-fA-F]{24}$/)) {
    return trimmed;
  }
  if (trimmed.match(/^DEV-[A-Z0-9]+-[A-F0-9]{8}$/i)) {
    return trimmed.toUpperCase();
  }
  return helpers.message('"{{#label}}" must be a valid mongo id or DEV ticket id');
};

/**
 * Page-size bound that CLAMPS instead of rejecting.
 *
 * A hard `.max(n)` turns an oversized `?limit=` into a 400 that kills the whole
 * screen, and it buys nothing: the server still never has to serve more than `n`
 * either way. Every already-deployed client that asks for more — the previous
 * frontend build during a release window, the mobile app, the task board's own
 * TASK_LIMIT — then breaks on a request the server could have answered.
 *
 * So: coerce into [1, max] and answer. The caller gets a short first page instead
 * of a dead list, and `validate.js` writes the clamped value back onto req.query,
 * so controllers and paginate() only ever see a bounded number.
 *
 * Deliberately silent — an out-of-range limit is a stale client, not an error the
 * user can act on. Non-numeric input still fails, as it should.
 *
 * @param {number} max - largest page size this endpoint will serve
 */
const boundedLimit = (max) =>
  Joi.number()
    .integer()
    .custom((value) => Math.min(Math.max(value, 1), max));

const password = (value, helpers) => {
  if (value.length < 8) {
    return helpers.message('password must be at least 8 characters');
  }
  if (!value.match(/\d/) || !value.match(/[a-zA-Z]/)) {
    return helpers.message('password must contain at least 1 letter and 1 number');
  }
  return value;
};

export { objectId, devTicketRef, password, boundedLimit, notificationPreferencesSchema };

