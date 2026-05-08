import Joi from 'joi';
import { objectId } from './custom.validation.js';

const getNotifications = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(50),
    unreadOnly: Joi.string().valid('true', 'false'),
  }),
};

const notificationIdParam = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const getAuditLog = {
  query: Joi.object()
    .keys({
      userId: Joi.string().custom(objectId),
      type: Joi.string().valid(
        'leave', 'task', 'offer', 'meeting', 'meeting_reminder',
        'course', 'certificate', 'job_application', 'project',
        'account', 'recruiter', 'assignment', 'sop', 'support_ticket',
        'chat_message', 'joining_reminder', 'placement_update',
        'onboarding_reminder', 'system', 'general'
      ),
      from: Joi.date().iso(),
      to: Joi.date().iso(),
      read: Joi.boolean(),
      page: Joi.number().integer().min(1),
      limit: Joi.number().integer().min(1).max(100),
    })
    .or('userId', 'from'),
};

export { getNotifications, notificationIdParam, getAuditLog };
