import MeetingModel from '../../../../../../models/meeting.model.js';
import JobApplicationModel from '../../../../../../models/jobApplication.model.js';
import JobModel from '../../../../../../models/job.model.js';
import EmployeeModel from '../../../../../../models/employee.model.js';
import UserModel from '../../../../../../models/user.model.js';
import ActivityLogModel from '../../../../../../models/activityLog.model.js';
import { getInterviewSchedulingBlockReason } from '../../../../../../constants/atsPipeline.js';
import {
  getMeetingById as realGetMeetingById,
  queryMeetings as realQueryMeetings,
  getInvitationEmails as realGetInvitationEmails,
  resendMeetingInvitations as realResendMeetingInvitations,
  createMeeting as realCreateMeeting,
  resolveJobPositionDisplayTitle,
} from '../../../../../meeting.service.js';
import { sendBookingLinkEmail as realSendBookingLinkEmail, formatSpoken } from '../../../../../interviewBooking.service.js';
import { buildApplicantQuery as realBuildApplicantQuery } from '../../../../../applicantQuery.service.js';
import { writeAtsAudit as realWriteAtsAudit } from '../../../../../atsAudit.service.js';
import { STALE_MESSAGE } from '../../../sageActions.js';

export const DOMAIN = 'interview_actions';
export const IST = 'Asia/Kolkata';
export const HEX_ID_RE = /^[0-9a-fA-F]{24}$/;
// Invitations are one email per address; the confirm card lists every one, so the cap matches MAX_TARGETS.
export const MAX_RECIPIENTS = 50;

// meeting.route.js POST /meetings/:id/resend-invitations is requirePermissions('interviews.manage'), but
// resendMeetingInvitations then runs assertMeetingInScope → meetingScope(read), which is empty without
// interviews.read — so the route's effective check is both.
export const RESEND_ACCESS = Object.freeze({ allOf: ['interviews.read', 'interviews.manage'] });
// meeting.route.js POST /meetings: requirePermissions('interviews.manage'). createMeeting does no scope
// check of its own; prepare proves the application is visible (applicationsVisibleQuery).
export const SCHEDULE_ACCESS = Object.freeze({ allOf: ['interviews.manage'] });
// sendBookingLinkEmail has no route (interviewHold.service calls it); gated like scheduling, which it leads to.
export const BOOKING_LINK_ACCESS = Object.freeze({ allOf: ['interviews.manage'] });

/** Fail closed: the scope builders treat a missing user as unrestricted. */
export function actorOf(ctx) {
  const id = ctx?.user?.id ?? ctx?.user?._id;
  if (!id) throw new Error('interview actions need an authenticated user with an id');
  return { user: ctx.user, userId: String(id) };
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo or send anything. */
export function actionDeps(ctx) {
  const d = ctx?.deps || {};
  return {
    getMeetingById: d.getMeetingById ?? realGetMeetingById,
    queryMeetings: d.queryMeetings ?? realQueryMeetings,
    resolveJobTitle: d.resolveJobTitle ?? resolveJobPositionDisplayTitle,
    getInvitationEmails: d.getInvitationEmails ?? realGetInvitationEmails,
    resendMeetingInvitations: d.resendMeetingInvitations ?? realResendMeetingInvitations,
    createMeeting: d.createMeeting ?? realCreateMeeting,
    sendBookingLinkEmail: d.sendBookingLinkEmail ?? realSendBookingLinkEmail,
    buildApplicantQuery: d.buildApplicantQuery ?? realBuildApplicantQuery,
    writeAtsAudit: d.writeAtsAudit ?? realWriteAtsAudit,
    Meeting: d.Meeting ?? MeetingModel,
    JobApplication: d.JobApplication ?? JobApplicationModel,
    Job: d.Job ?? JobModel,
    Employee: d.Employee ?? EmployeeModel,
    User: d.User ?? UserModel,
    ActivityLog: d.ActivityLog ?? ActivityLogModel,
    now: d.now ?? (() => new Date()),
  };
}

export const formatIst = (date) => `${formatSpoken(date, IST)} (IST)`;

/**
 * writeAtsAudit reads its source from the x-audit-source header; 'sage' is not on the allowlist (it would
 * become 'system'), 'ats/sage' is. Commit has no Express request, so this stands in for one.
 */
export function sageAuditReq(ctx) {
  const requestId = ctx?.requestId ? String(ctx.requestId) : null;
  return {
    headers: { 'x-audit-source': 'ats/sage', ...(requestId ? { 'x-request-id': requestId } : {}) },
    ...(requestId ? { id: requestId } : {}),
  };
}

/**
 * One application by id, visible to the viewer exactly as list_applications sees it: buildApplicantQuery's
 * applicationScope plus the internal/relay-applicant exclusion. Inactive candidate profiles are refused
 * separately (list_applications hides them by default) so the reason is not reported as scope.
 */
export async function resolveApplication(applicationId, user, deps) {
  const { query } = await deps.buildApplicantQuery({ excludeInternal: true, includeInactive: true }, user);
  const app = await deps.JobApplication.findOne({ $and: [query, { _id: applicationId }] })
    .select('job candidate status').lean();
  if (!app) {
    const exists = await deps.JobApplication.exists({ _id: applicationId });
    return { error: exists ? '1 application is outside your scope.' : 'No application found with that id.' };
  }
  const [job, candidate] = await Promise.all([
    deps.Job.findById(app.job).select('title status interviewerPool').lean(),
    deps.Employee.findById(app.candidate).select('fullName email phoneNumber isActive').lean(),
  ]);
  if (!job) return { error: 'The job for this application no longer exists.' };
  if (!candidate) return { error: 'The candidate profile for this application no longer exists.' };
  const name = candidate.fullName || 'The candidate';
  if (candidate.isActive === false) return { error: `${name}'s candidate profile is inactive.` };
  return { app, job, candidate, name, jobTitle: job.title || 'the role' };
}

/** Same rules as the schedule form's picker (scheduleEligible: eligible status, active job) and createMeeting. */
export function schedulingBlock(app, job) {
  const reason = getInterviewSchedulingBlockReason(app.status);
  if (reason) return reason;
  if (job.status !== 'Active') return `The job "${job.title || 'this job'}" is not active (${job.status}).`;
  return null;
}

/**
 * Who each invitation address is, for the confirm card: host / candidate / recruiter / panel / invited.
 * `emails` come from meeting.service getInvitationEmails (lower-cased, deduped).
 */
export function recipientLines(meeting, emails) {
  const same = (a, b) => !!a && String(a).trim().toLowerCase() === b;
  return emails.map((email) => {
    const roles = [];
    let name = null;
    const host = (meeting.hosts || []).find((h) => same(h.email, email));
    if (host) { roles.push('host'); name = name || host.nameOrRole || null; }
    if (same(meeting.candidate?.email, email)) { roles.push('candidate'); name = name || meeting.candidate?.name || null; }
    if (same(meeting.recruiter?.email, email)) { roles.push('recruiter'); name = name || meeting.recruiter?.name || null; }
    const agent = (meeting.agents || []).find((a) => same(a?.email, email));
    if (agent) { roles.push('panel'); name = name || agent.name || null; }
    if ((meeting.emailInvites || []).some((e) => same(e, email)) && !roles.length) roles.push('invited');
    return `• ${name ? `${name} ` : ''}(${roles.join(', ') || 'invited'}) — ${email}`;
  });
}

/**
 * Confirm-time check for tools whose card carries more than target ids (recipients, times, clashes):
 * re-run prepare and refuse unless the targets, every summary line and the payload are unchanged, so
 * commit never does something the card did not say.
 */
export function recheckSameDraft(prepare) {
  return async (draft, ctx) => {
    const fresh = await prepare(draft.args, ctx);
    if (!fresh?.ok) return { ok: false, error: fresh?.error || STALE_MESSAGE };
    const ids = (s) => JSON.stringify((s?.targets || []).map((t) => String(t.id)).sort());
    const same = ids(fresh.summary) === ids(draft.summary)
      && JSON.stringify(fresh.summary.lines) === JSON.stringify(draft.summary?.lines)
      && JSON.stringify(fresh.payload) === JSON.stringify(draft.payload);
    return same ? { ok: true } : { ok: false, error: STALE_MESSAGE };
  };
}
