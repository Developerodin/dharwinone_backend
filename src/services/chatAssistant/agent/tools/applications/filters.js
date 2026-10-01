import Joi from 'joi';
import { APPLICATION_STATUSES } from '../../../../../constants/atsPipeline.js';

export const applicationFilters = Joi.object({
  applicantName: Joi.string().min(1)
    .description('The applicant\'s real name or email. NEVER a pronoun or "this user" — resolve it from the conversation first.'),
  applicantUserId: Joi.string().min(1).description('The applicant\'s user id (id from get_user / list_users).'),
  jobTitle: Joi.string().min(1).description('Job title to narrow to (partial match).'),
  jobId: Joi.string().min(1),
  status: Joi.string().valid(...APPLICATION_STATUSES),
  inStatusOverDays: Joi.number().integer().min(1).max(3650)
    .description('Applications in their current status for more than this many whole IST days. Counted from the last statusHistory entry. No history is left out — never guessed from the apply date.'),
  screenedNeverInterviewed: Joi.boolean()
    .description('Status history contains Screening and does not contain Interview. Applications with no status history are not included; they are reported separately as screeningUnknown and are neither screened nor not screened.'),
}).description('Job application filters.');
