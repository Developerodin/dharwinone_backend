import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import { ActivityActions, EntityTypes } from '../../../../../../config/activityLog.js';
import { resolveInterview, jobTitleFor, idOf } from '../../hiring/interviewDetail.js';
import {
  DOMAIN, HEX_ID_RE, MAX_RECIPIENTS, RESEND_ACCESS, actorOf, actionDeps, formatIst, sageAuditReq,
  recipientLines, recheckSameDraft,
} from './common.js';

const MEETING_ROOM_ID_RE = /^meeting_[0-9a-f]+$/i;
const MAX_MATCHES_SHOWN = 5;

const looksLikeId = (v) => HEX_ID_RE.test(v) || MEETING_ROOM_ID_RE.test(v);

async function outsideScopeOrMissing(id, deps) {
  const exists = HEX_ID_RE.test(id)
    ? await deps.Meeting.exists({ _id: id })
    : await deps.Meeting.exists({ meetingId: id });
  return exists ? '1 interview is outside your scope.' : 'No interview found with that id.';
}

async function prepare({ interview }, ctx) {
  const { user } = actorOf(ctx);
  const deps = actionDeps(ctx);
  const byId = looksLikeId(interview);
  const found = await resolveInterview(byId ? { id: interview } : { candidate: interview }, user, deps);
  if (found.notFound) {
    return { ok: false, error: byId ? await outsideScopeOrMissing(interview, deps) : `No interview you can see matches "${interview}".` };
  }
  if (found.matches) {
    const shown = found.matches.slice(0, MAX_MATCHES_SHOWN).map((m) =>
      `${m.candidate || 'Unknown'} — ${m.jobPosition || 'no job'}, ${m.scheduledAt ? formatIst(m.scheduledAt) : 'no time'} (id ${m.id})`);
    return { ok: false, error: `${found.total} interviews match "${interview}". Say which one by id: ${shown.join('; ')}.` };
  }

  const m = found.meeting;
  if (String(m.status || '').toLowerCase() === 'cancelled') {
    return { ok: false, error: 'This interview is cancelled, so its invitations cannot be re-sent.' };
  }
  const emails = deps.getInvitationEmails(m);
  if (!emails.length) return { ok: false, error: 'This interview has no one to invite (no host, candidate or recruiter email).' };
  if (emails.length > MAX_RECIPIENTS) {
    return { ok: false, error: `This would email ${emails.length} addresses; at most ${MAX_RECIPIENTS} can be invited at once.` };
  }

  const id = idOf(m);
  const jobTitle = (await jobTitleFor(m, deps)) || 'no job';
  const candidate = m.candidate?.name || 'Unknown candidate';
  const title = m.title || 'Interview';
  const past = m.scheduledAt && new Date(m.scheduledAt).getTime() <= deps.now().getTime();
  return {
    ok: true,
    summary: {
      title: `Re-send the invitation for ${candidate}'s interview`,
      lines: [
        `Interview: "${title}" — ${candidate} · ${jobTitle} · ${m.scheduledAt ? formatIst(m.scheduledAt) : 'no time set'}`,
        ...(past ? ['Note: this interview\'s time has already passed.'] : []),
        'Channel: email with a calendar invite, plus an in-app notification for recipients who have a DharwinOne login.',
        `Message: subject "Meeting invitation: ${title}" — "You have been invited to join a scheduled meeting on Dharwin."`,
        `Recipients (${emails.length}):`,
        ...recipientLines(m, emails),
        'Skipped: recipients who turned meeting emails off in their notification settings.',
        'Skipped: a repeat of this same confirmation sends nothing again.',
      ],
      targetCount: 1,
      targets: [{ id, name: `${candidate} — ${jobTitle}` }],
      confirmLabel: 'Re-send invitation',
    },
    payload: { interviewId: id },
  };
}

export default defineTool({
  name: 'resend_interview_invite',
  domain: DOMAIN,
  kind: 'write',
  description:
    'Draft re-sending the invitation emails for ONE ATS interview (the Interviews page "Resend invitations" ' +
    'button). Sends to every invitee: hosts, panel, candidate, recruiter and invited guests. Only drafts: ' +
    'the user must press Confirm. Use only when the user asks to re-send / resend an interview invite.',
  input: Joi.object({
    interview: Joi.string().trim().min(1).max(200).required()
      .description('Interview id from list_interviews / get_interview, or the candidate\'s name.'),
  }),
  access: RESEND_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: recheckSameDraft(prepare),
  async commit(draft, ctx) {
    const { user, userId } = actorOf(ctx);
    const deps = actionDeps(ctx);
    const { interviewId } = draft.payload;
    // The audit row below carries this confirmation's key, so a replay of it is detectable.
    const replay = await deps.ActivityLog.exists({
      action: ActivityActions.INTERVIEW_INVITATION_RESEND,
      entityType: EntityTypes.MEETING,
      entityId: String(interviewId),
      'metadata.sageAction': String(draft.key),
    });
    if (replay) return { ok: true, message: 'Already re-sent for this confirmation — nothing sent again.', details: { skipped: true } };

    const { sent } = await deps.resendMeetingInvitations(interviewId, user);
    // Same row meeting.controller resendInvitations writes; fail-soft so a logging failure never
    // relabels invitations that already went out.
    await Promise.resolve()
      .then(() => deps.writeAtsAudit(
        userId,
        {
          action: ActivityActions.INTERVIEW_INVITATION_RESEND,
          entityType: EntityTypes.MEETING,
          entityId: String(interviewId),
          metadata: { sageAction: String(draft.key) },
        },
        sageAuditReq(ctx),
        { editContext: { staffEdit: true } },
      ))
      .catch(() => null);
    return { ok: true, message: `Invitation re-sent to ${sent} recipient${sent === 1 ? '' : 's'}.`, details: { sent } };
  },
});
