import Joi from 'joi';
import {
  INTERVIEW_STATUSES, INTERVIEW_RESULTS, OFFER_STATUSES, PLACEMENT_STATUSES, PRE_BOARDING_STATUSES,
} from '../../../../../constants/atsPipeline.js';
import { REFERRAL_PIPELINE_STATUSES } from '../../../referralLeadFieldMap.js';

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.'); // format checked in common.js
// Inclusive whole IST days (context.js DEFAULT_TIMEZONE), same bounds as the employee joined/resigned windows.
const dayWindow = (what) => Joi.object({ from: isoDay, to: isoDay }).or('from', 'to')
  .description(`${what} on or between these days (inclusive), resolved from today's date.`);

export const interviewFilters = Joi.object({
  candidate: Joi.string().min(1).description('The candidate (person being interviewed) — name, partial match.'),
  interviewer: Joi.string().min(1)
    .description('The recruiter or a panel interviewer running it — name, partial match. Never the candidate.'),
  jobPosition: Joi.string().min(1).description('Job position the interview is for, partial match.'),
  status: Joi.string().valid(...INTERVIEW_STATUSES).description('Lifecycle: scheduled, ended or cancelled.'),
  result: Joi.string().valid(...INTERVIEW_RESULTS).description('Outcome: pending, selected or rejected.'),
  scheduledBetween: dayWindow('Interview slot (scheduledAt)'),
}).description('Interview filters (ATS interviews only — never internal meetings). Omit a key to leave it unfiltered.');

export const offerFilters = Joi.object({
  search: Joi.string().min(1)
    .description('Candidate name/email/employee id, job title or offer code — like the Offers page search box.'),
  status: Joi.string().valid(...OFFER_STATUSES),
  stage: Joi.string().valid('preBoarding', 'onboarding')
    .description('Only accepted offers whose placement is in the Pre-boarding or Onboarding queue.'),
  createdBetween: dayWindow('Offer created (prepared)'),
}).description('Offer filters. Omit a key to leave it unfiltered.');

export const placementFilters = Joi.object({
  search: Joi.string().min(1)
    .description('Candidate name/email/employee id or job title — like the page search box.'),
  status: Joi.string().valid(...PLACEMENT_STATUSES)
    .description('Pending, Onboarding, Joined, Deferred or Cancelled. Omitted = every status except Cancelled.'),
  preBoardingStatus: Joi.string().valid(...PRE_BOARDING_STATUSES),
  stage: Joi.string().valid('preBoarding', 'onboarding')
    .description('The Pre-boarding or Onboarding queue (accepted offers only).'),
  joiningBetween: dayWindow('Joining date'),
}).description('Placement filters. Omit a key to leave it unfiltered.');

export const funnelFilters = Joi.object({
  referredBetween: dayWindow('Referral claimed (referredAt)'),
  linkType: Joi.string().valid('JOB_APPLY', 'SHARE_CANDIDATE_ONBOARD')
    .description('JOB_APPLY = job link, SHARE_CANDIDATE_ONBOARD = onboard invite.'),
}).description('Hiring funnel filters. Omit a key for all referral leads.');

export const referralLeadFilters = Joi.object({
  candidate: Joi.string().min(1).description('The referred candidate — name or email, partial match.'),
  referrer: Joi.string().min(1).description('Name or email of the person who referred them, or "me".'),
  salesAgent: Joi.string().min(1).description('Name or email of the assigned sales agent, or "me".'),
  unassigned: Joi.boolean().valid(true).description('Only leads with no sales agent assigned.'),
  status: Joi.string().valid(...REFERRAL_PIPELINE_STATUSES).description('Pipeline status shown on the Refer Leads page.'),
  linkType: Joi.string().valid('JOB_APPLY', 'SHARE_CANDIDATE_ONBOARD')
    .description('JOB_APPLY = job link, SHARE_CANDIDATE_ONBOARD = onboard invite.'),
  claimedBetween: dayWindow('Referral claimed (referredAt)'),
}).description('Referral lead filters. Omit a key to leave it unfiltered.');
