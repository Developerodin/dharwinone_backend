import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import * as meetingValidation from '../../../../../../validations/meeting.validation.js';
import { computeRemindAt, reminderLeadMin } from '../../../../../meeting.service.js';
import { panelOverlaps, MAX_DURATION_MIN, OVERLAP_SCAN_LIMIT } from '../../hiring/interviewDetail.js';
import { canUserBeVisible } from '../../../../visibilityRules.js';
import {
  DOMAIN, IST, HEX_ID_RE, MAX_RECIPIENTS, SCHEDULE_ACCESS, actorOf, actionDeps, formatIst, resolveApplication,
  schedulingBlock, recipientLines, recheckSameDraft,
} from './common.js';

const ROUTE_BODY = meetingValidation.createMeeting.body;
// An explicit offset is required so "3 PM" can never be read in the server's zone.
// Seconds / fractions are left to the Date parse in plan(), which refuses anything invalid.
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[0-9:.]{0,10}(Z|[+-]\d{2}:\d{2})$/;
const MAX_HOSTS = 10;
const MAX_CLASHES_SHOWN = 5;
// createMeeting only moves these statuses to Interview (transitionApplicationToInterview).
const MOVES_TO_INTERVIEW = ['Applied', 'Screening'];
const NOT_CANCELLED = { status: { $not: /^cancelled$/i } };
const NEW_ROUND = '__new__';

/** Host entries are user ids or login emails; only existing, visible DharwinOne users can host. */
async function resolveHosts(entries, viewer, userId, deps) {
  const users = [];
  for (const raw of entries) {
    const v = String(raw).trim();
    const q = HEX_ID_RE.test(v) ? deps.User.findById(v) : deps.User.findOne({ email: v.toLowerCase() });
    const u = await q.select('name email status platformSuperUser').lean();
    const self = !!u && String(u._id) === userId;
    if (!u || (!self && !viewer.platformSuperUser && !canUserBeVisible(u))) {
      return { error: `No active DharwinOne user matches host "${v}".` };
    }
    if (!u.email) return { error: `${u.name || v} has no email address, so they cannot host.` };
    if (!users.some((x) => String(x._id) === String(u._id))) users.push(u);
  }
  return { users };
}

/**
 * Everything prepare shows and commit sends, from ids only. `hostIds` (commit) replaces `hosts` (the
 * model's ids / emails), so commit re-reads names and emails instead of trusting stored text.
 */
async function plan(args, ctx, { hostIds } = {}) {
  const { user, userId } = actorOf(ctx);
  const deps = actionDeps(ctx);
  const start = new Date(args.scheduledAt);
  if (Number.isNaN(start.getTime())) return { error: `"${args.scheduledAt}" is not a valid date-time.` };
  const now = deps.now();
  if (start.getTime() <= now.getTime()) return { error: `The start time must be in the future; ${formatIst(start)} has passed.` };

  const found = await resolveApplication(args.application, user, deps);
  if (found.error) return found;
  const { app, job, candidate, name, jobTitle } = found;
  const blocked = schedulingBlock(app, job);
  if (blocked) return { error: blocked };

  const hosts = await resolveHosts(hostIds ?? (args.hosts?.length ? args.hosts : [userId]), user, userId, deps);
  if (hosts.error) return hosts;

  // Same shape interviewHold.service approveHold builds for createMeeting; recruiter = the scheduler.
  const raw = {
    title: `Interview: ${candidate.fullName || 'Candidate'} — ${job.title || 'Role'}`,
    scheduledAt: start,
    timezone: IST,
    durationMinutes: args.durationMinutes,
    interviewType: args.interviewType,
    hosts: hosts.users.map((u) => ({ nameOrRole: u.name || 'Interviewer', email: u.email })),
    agents: hosts.users.map((u) => ({ id: String(u._id), name: u.name || '', email: u.email })),
    jobPosition: String(job._id),
    candidate: { id: String(candidate._id), name: candidate.fullName || '', email: candidate.email || null, phone: candidate.phoneNumber || '' },
    recruiter: { id: userId, name: user.name || '', email: user.email || null },
    applicationId: String(app._id),
  };
  const { value: body, error } = ROUTE_BODY.validate(raw, { abortEarly: false });
  if (error) return { error: `The interview details are invalid: ${error.details.map((d) => d.message).join('; ')}` };

  const duplicate = !!(await deps.Meeting.exists({ applicationId: app._id, scheduledAt: start, status: { $ne: 'cancelled' } }));
  return { user, deps, now, start, app, job, candidate, name, jobTitle, hostUsers: hosts.users, body, duplicate };
}

/** list_interviews' overlapping rule (hiring/interviewDetail panelOverlaps) with the new round added. */
async function clashLines(p) {
  const { body, start, user, deps } = p;
  const end = new Date(start.getTime() + body.durationMinutes * 60000);
  const scan = { $and: [{ scheduledAt: { $gte: new Date(start.getTime() - MAX_DURATION_MIN * 60000), $lt: end } }, NOT_CANCELLED] };
  const res = await deps.queryMeetings(scan, { limit: OVERLAP_SCAN_LIMIT, page: 1, sortBy: 'scheduledAt:asc' }, user);
  if ((res?.totalResults ?? 0) > OVERLAP_SCAN_LIMIT) {
    return [`Clash check skipped: over ${OVERLAP_SCAN_LIMIT} interviews near that time.`];
  }
  const overlaps = panelOverlaps([
    ...(res?.results || []),
    { id: NEW_ROUND, scheduledAt: start, durationMinutes: body.durationMinutes, recruiter: body.recruiter, agents: body.agents },
  ]);
  const hits = overlaps.get(NEW_ROUND) || [];
  if (!hits.length) return ['No clashes found for the panel among interviews you can see.'];
  return hits.slice(0, MAX_CLASHES_SHOWN).map((h) =>
    `Warning — clash: ${h.panelMember || 'a panel member'} already has an interview with ${h.candidate || 'another candidate'} at ${formatIst(h.scheduledAt)}.`);
}

async function prepare(args, ctx) {
  const p = await plan(args, ctx);
  if (p.error) return { ok: false, error: p.error };
  const { body, start, now, app, candidate, name, jobTitle, hostUsers, user, deps } = p;
  if (p.duplicate) return { ok: false, error: `${name} already has an interview for ${jobTitle} at ${formatIst(start)}.` };

  const emails = deps.getInvitationEmails(body);
  if (emails.length > MAX_RECIPIENTS) {
    return { ok: false, error: `This would email ${emails.length} addresses; at most ${MAX_RECIPIENTS} can be invited at once.` };
  }
  const reminder = computeRemindAt(start, now)
    ? `The same invitees get the automatic reminder email ${reminderLeadMin()} minutes before the start.`
    : 'No reminder email: it starts within the reminder lead time.';
  return {
    ok: true,
    summary: {
      title: `Schedule ${name}'s interview for ${jobTitle}`,
      lines: [
        `When: ${formatIst(start)} · ${body.durationMinutes} min · ${body.interviewType}`,
        `Job: ${jobTitle}`,
        candidate.email
          ? `Candidate: ${name} — ${candidate.email} (the candidate profile's own email)`
          : `Candidate: ${name} — no email on the profile, so the candidate gets no invitation.`,
        `Panel (hosts): ${hostUsers.map((u) => u.name || u.email).join(', ')}`,
        `Recruiter on the invite: ${user.name || 'you'} (you)`,
        MOVES_TO_INTERVIEW.includes(app.status)
          ? `Moves the application from ${app.status} to Interview.`
          : `The application stays at ${app.status}.`,
        'Channel: every invitee gets an invitation email with a calendar invite, plus an in-app notification if they have a DharwinOne login.',
        `Message: subject "Meeting invitation: ${body.title}" — "You have been invited to join a scheduled meeting on Dharwin."`,
        `Invitees (${emails.length}):`,
        ...recipientLines(body, emails),
        reminder,
        ...(await clashLines(p)),
        'Skipped on confirm: if this application already has an interview at this exact time, nothing is created.',
      ],
      targetCount: 1,
      targets: [{ id: String(app._id), name: `${name} — ${jobTitle}` }],
      confirmLabel: 'Schedule interview',
    },
    payload: { applicationId: String(app._id), hostUserIds: hostUsers.map((u) => String(u._id)) },
  };
}

export default defineTool({
  name: 'schedule_interview',
  domain: DOMAIN,
  kind: 'write',
  description:
    'Draft scheduling one ATS interview for one job application at a fixed time (the Interviews page ' +
    '"Schedule interview" form). Only drafts: nothing is created and nobody is emailed until the user presses Confirm. ' +
    'If the user already gave the application id, pass that id and do not call list_applications. ' +
    'Call list_applications only when you have a candidate and job but no application id. ' +
    'To let the candidate pick the time, use send_interview_booking_link.',
  input: Joi.object({
    application: Joi.string().pattern(HEX_ID_RE).required()
      .description('Application id the user gave, or from list_applications when they did not.'),
    scheduledAt: Joi.string().pattern(ISO_WITH_OFFSET_RE).required()
      .description('Start, ISO 8601 with an explicit offset, e.g. 2026-10-02T15:00:00+05:30 for 3 PM IST. Must be in the future.'),
    durationMinutes: ROUTE_BODY.extract('durationMinutes').description('Length in minutes (default 60).'),
    interviewType: ROUTE_BODY.extract('interviewType').description('Video (default), In-Person or Phone.'),
    hosts: Joi.array().items(Joi.string().trim().min(3).max(254)).min(1).max(MAX_HOSTS).unique()
      .description('Interviewers: DharwinOne user ids or login emails. Omit to host it yourself.'),
  }),
  access: SCHEDULE_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: recheckSameDraft(prepare),
  async commit(draft, ctx) {
    const { userId } = actorOf(ctx);
    const { applicationId, hostUserIds } = draft.payload;
    const p = await plan({ ...draft.args, application: applicationId }, ctx, { hostIds: hostUserIds });
    if (p.error) return { ok: false, message: p.error };
    const who = draft.summary?.targets?.[0]?.name || p.name;
    if (p.duplicate) {
      return { ok: true, message: `Already scheduled: ${who} has an interview at ${formatIst(p.start)} — nothing created.`, details: { skipped: true } };
    }
    const meeting = await p.deps.createMeeting(p.body, userId);
    return {
      ok: true,
      message: `Interview scheduled: ${who}, ${formatIst(p.start)}. Invitations are on their way.`,
      details: { interviewId: String(meeting?.id ?? meeting?._id ?? '') },
    };
  },
});
