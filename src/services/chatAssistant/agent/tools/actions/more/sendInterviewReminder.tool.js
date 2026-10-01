import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import MeetingModel from '../../../../../../models/meeting.model.js';
import {
  getMeetingById as realGetMeetingById,
  queryMeetings as realQueryMeetings,
  getInvitationEmails as realGetInvitationEmails,
  resolveJobPositionDisplayTitle,
} from '../../../../../meeting.service.js';
import { resolveInterview, jobTitleFor, idOf } from '../../hiring/interviewDetail.js';
import { formatIst, recipientLines, HEX_ID_RE as INTERVIEW_HEX } from '../interviews/common.js';
import { actorOf, recheckSameDraft } from './common.js';
import { deliverInterviewReminder } from './deliverInterviewReminder.js';

const MAX_MATCHES_SHOWN = 5;
const MAX_RECIPIENTS = 50;
const MEETING_ROOM_ID_RE = /^meeting_[0-9a-f]+$/i;

// No user route sends one interview reminder (the scheduler does). Seeing the interview is
// meetingScope, which is empty without interviews.read, and sending is a manage action on that
// meeting — the same effective check as POST /meetings/:id/resend-invitations.
export const REMINDER_ACCESS = Object.freeze({ allOf: ['interviews.read', 'interviews.manage'] });

function reminderDeps(ctx) {
  const d = ctx?.deps || {};
  const base = {
    getMeetingById: d.getMeetingById ?? realGetMeetingById,
    queryMeetings: d.queryMeetings ?? realQueryMeetings,
    resolveJobTitle: d.resolveJobTitle ?? resolveJobPositionDisplayTitle,
    getInvitationEmails: d.getInvitationEmails ?? realGetInvitationEmails,
    Meeting: d.Meeting ?? MeetingModel,
    now: d.now ?? (() => new Date()),
    User: d.User,
    notify: d.notify,
    sendMeetingReminderEmail: d.sendMeetingReminderEmail,
    dispatchReminder: d.dispatchReminder,
    getPublicMeetingUrl: d.getPublicMeetingUrl,
    getInAppMeetingLink: d.getInAppMeetingLink,
  };
  return {
    ...base,
    sendInterviewReminder: d.sendInterviewReminder ?? ((meeting) => deliverInterviewReminder(meeting, base)),
  };
}

const looksLikeId = (v) => INTERVIEW_HEX.test(v) || MEETING_ROOM_ID_RE.test(v);

function reminderBlock(meeting, now) {
  const status = String(meeting.status || '').toLowerCase();
  if (status === 'cancelled') return 'This interview is cancelled, so a reminder cannot be sent.';
  if (status === 'ended') return 'This interview has ended, so a reminder cannot be sent.';
  if (!meeting.scheduledAt || Number.isNaN(new Date(meeting.scheduledAt).getTime())) {
    return 'This interview has no start time, so a reminder cannot be sent.';
  }
  if (new Date(meeting.scheduledAt).getTime() <= now.getTime()) {
    return 'This interview\'s time has already passed, so a reminder cannot be sent.';
  }
  if (meeting.reminderSentAt) return 'A reminder was already sent for this interview, so nothing new will be sent.';
  return null;
}

async function outsideScopeOrMissing(id, deps) {
  const exists = INTERVIEW_HEX.test(id)
    ? await deps.Meeting.exists({ _id: id })
    : await deps.Meeting.exists({ meetingId: id });
  return exists ? '1 interview is outside your scope.' : 'No interview found with that id.';
}

async function prepare({ interview }, ctx) {
  const { user } = actorOf(ctx);
  const deps = reminderDeps(ctx);
  const byId = looksLikeId(interview);
  const found = await resolveInterview(
    byId ? { id: interview } : { candidate: interview },
    user,
    deps,
  );
  if (found.notFound) {
    return { ok: false, error: byId ? await outsideScopeOrMissing(interview, deps) : `No interview you can see matches "${interview}".` };
  }
  if (found.matches) {
    const shown = found.matches.slice(0, MAX_MATCHES_SHOWN).map((m) =>
      `${m.candidate || 'Unknown'} — ${m.jobPosition || 'no job'}, ${m.scheduledAt ? formatIst(m.scheduledAt) : 'no time'} (id ${m.id})`);
    return { ok: false, error: `${found.total} interviews match "${interview}". Say which one by id: ${shown.join('; ')}.` };
  }

  const m = found.meeting;
  const block = reminderBlock(m, deps.now());
  if (block) return { ok: false, error: block };

  const emails = deps.getInvitationEmails(m);
  if (!emails.length) return { ok: false, error: 'This interview has no one to remind (no host, candidate or recruiter email).' };
  if (emails.length > MAX_RECIPIENTS) {
    return { ok: false, error: `This would remind ${emails.length} addresses; at most ${MAX_RECIPIENTS} can be reminded at once.` };
  }

  const id = idOf(m);
  const jobTitle = (await jobTitleFor(m, deps)) || 'no job';
  const candidate = m.candidate?.name || 'Unknown candidate';
  const title = m.title || 'Interview';
  return {
    ok: true,
    summary: {
      title: `Send a reminder for ${candidate}'s interview`,
      lines: [
        `Send a reminder now for "${title}" — ${candidate} · ${jobTitle} · ${formatIst(m.scheduledAt)}.`,
        'Channel: email, plus an in-app notification for recipients who have a DharwinOne login.',
        `Message: subject "Reminder: ${title} starts soon" — "Your interview \\"${title}\\" starts soon." In-app title "Interview reminder".`,
        `Recipients (${emails.length}):`,
        ...recipientLines(m, emails),
        'Skipped: recipients who turned meeting reminder emails off.',
        'Skipped: a reminder that was already sent is not sent again.',
      ],
      targetCount: 1,
      targets: [{ id, name: `${candidate} — ${jobTitle}` }],
      confirmLabel: 'Send reminder',
    },
    payload: { interviewId: id },
  };
}

async function commit(draft, ctx) {
  const { user } = actorOf(ctx);
  const deps = reminderDeps(ctx);
  const { interviewId } = draft.payload;
  let meeting;
  try {
    meeting = await deps.getMeetingById(String(interviewId), user);
  } catch (err) {
    if (err?.statusCode === 404) return { ok: false, message: 'This interview is outside your scope.' };
    throw err;
  }
  if (!meeting) return { ok: false, message: 'No interview found with that id.' };
  const block = reminderBlock(meeting, deps.now());
  if (block) {
    const already = !!meeting.reminderSentAt;
    if (already) return { ok: true, message: 'A reminder was already sent — nothing sent again.', details: { skipped: true } };
    return { ok: false, message: block };
  }

  const result = await deps.sendInterviewReminder(meeting);
  if (!result?.ok) return { ok: false, message: result?.error || 'The reminder could not be sent.' };
  await deps.Meeting.updateOne(
    { _id: interviewId, reminderSentAt: null },
    { $set: { reminderSentAt: deps.now() } },
  );
  const delivered = result.delivered ?? 0;
  const message = delivered
    ? `Reminder sent to ${delivered} recipient${delivered === 1 ? '' : 's'}.`
    : 'Reminder recorded; every recipient had reminders turned off, so nothing was delivered.';
  return { ok: true, message, details: { delivered, skippedRecipients: result.skipped ?? 0 } };
}

export default defineTool({
  name: 'send_interview_reminder',
  domain: 'actions',
  kind: 'write',
  description:
    'Draft sending the interview reminder for ONE ATS interview now (the same email and in-app notice the ' +
    'reminder scheduler sends). Only drafts: the user must press Confirm. Refuses a cancelled interview, ' +
    'one whose start time has passed, or one whose reminder was already sent. Use only when the user asks ' +
    'to send / remind about an interview. A question about whether the reminder went out is get_interview, not this.',
  input: Joi.object({
    interview: Joi.string().trim().min(1).max(200).required()
      .description('Interview id from list_interviews / get_interview, or the candidate\'s name.'),
  }),
  access: REMINDER_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: recheckSameDraft(prepare),
  commit,
});
