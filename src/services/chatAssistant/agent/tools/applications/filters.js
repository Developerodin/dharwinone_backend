import Joi from 'joi';
import { APPLICATION_STATUSES } from '../../../../../constants/atsPipeline.js';

export const applicationFilters = Joi.object({
  applicantName: Joi.string().min(1)
    .description('The applicant\'s real name or email. NEVER a pronoun or "this user" — resolve it from the conversation first.'),
  applicantUserId: Joi.string().min(1).description('The applicant\'s user id (id from get_user / list_users).'),
  jobTitle: Joi.string().min(1).description('Job title to narrow to (partial match).'),
  jobId: Joi.string().min(1),
  status: Joi.string().valid(...APPLICATION_STATUSES),
}).description('Job application filters.');
