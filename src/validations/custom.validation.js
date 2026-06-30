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

const password = (value, helpers) => {
  if (value.length < 8) {
    return helpers.message('password must be at least 8 characters');
  }
  if (!value.match(/\d/) || !value.match(/[a-zA-Z]/)) {
    return helpers.message('password must contain at least 1 letter and 1 number');
  }
  return value;
};

export { objectId, password, notificationPreferencesSchema };

