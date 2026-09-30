import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import { ActivityActions, EntityTypes } from '../../../../../../config/activityLog.js';
import { bookingEmailCopy } from '../../../../../interviewBooking.service.js';
import {
  DOMAIN, HEX_ID_RE, BOOKING_LINK_ACCESS, actorOf, actionDeps, resolveApplication, schedulingBlock, recheckSameDraft,
} from './common.js';

async function prepare({ application }, ctx) {
  const { user } = actorOf(ctx);
  const deps = actionDeps(ctx);
  const found = await resolveApplication(application, user, deps);
  if (found.error) return { ok: false, error: found.error };
  const { app, job, candidate, name, jobTitle } = found;
  // sendBookingLinkEmail resolves false and sends nothing without one — refuse here instead.
  if (!candidate.email) {
    return { ok: false, error: `${name}'s candidate profile has no email address, so there is no one to send the link to.` };
  }
  const blocked = schedulingBlock(app, job);
  if (blocked) return { ok: false, error: `The booking link leads to scheduling an interview: ${blocked}` };

  // No reason → the original "choose your interview time" copy, the one commit sends.
  const copy = bookingEmailCopy({ name: candidate.fullName || 'there', jobTitle, url: '[booking link]' });
  const noPool = !(job.interviewerPool || []).length;
  return {
    ok: true,
    summary: {
      title: `Email ${name} an interview booking link`,
      lines: [
        `To: ${name} — ${candidate.email} (the candidate profile's own email)`,
        `Job: ${jobTitle} · application status ${app.status}`,
        'Channel: email only (no in-app notification).',
        `Subject: "${copy.subject}"`,
        `Message: "${copy.text.replace(/\s+/g, ' ').trim()}"`,
        ...(noPool ? ['Warning: this job has no interviewer pool, so the booking page will show no free times.'] : []),
        'Each confirm emails a new link; links sent earlier stay valid until they expire.',
        'Not recorded in the interview history; the Sage action log is the record.',
      ],
      targetCount: 1,
      targets: [{ id: String(app._id), name: `${name} — ${jobTitle}` }],
      confirmLabel: 'Send booking link',
    },
    payload: { applicationId: String(app._id) },
  };
}

export default defineTool({
  name: 'send_interview_booking_link',
  domain: DOMAIN,
  kind: 'write',
  description:
    'Draft emailing ONE candidate a self-service link to pick their own interview time for one job ' +
    'application. Only drafts: the user must press Confirm. Use when the user asks to send / re-send a ' +
    'booking link or let the candidate choose a slot; to fix a time yourself use schedule_interview.',
  input: Joi.object({
    application: Joi.string().pattern(HEX_ID_RE).required()
      .description('Job application id from list_applications.'),
  }),
  access: BOOKING_LINK_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: recheckSameDraft(prepare),
  async commit(draft, ctx) {
    actorOf(ctx);
    const deps = actionDeps(ctx);
    const { applicationId } = draft.payload;
    // sendBookingLinkEmail writes no audit row; the framework's confirmed row for this key is the record.
    const replay = await deps.ActivityLog.exists({
      action: ActivityActions.SAGE_ACTION_CONFIRMED,
      entityType: EntityTypes.SAGE_ACTION,
      entityId: String(draft.key),
    });
    if (replay) return { ok: true, message: 'Already sent for this confirmation — nothing sent again.', details: { skipped: true } };

    const sent = await deps.sendBookingLinkEmail(applicationId);
    const who = draft.summary?.targets?.[0]?.name || 'the candidate';
    if (!sent) return { ok: false, message: `The booking link was not sent to ${who}: the application or its candidate email is gone.` };
    return { ok: true, message: `Booking link emailed to ${who}.`, details: { sent: true } };
  },
});
