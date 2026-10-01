import UserModel from '../../../../../../models/user.model.js';
import { getInvitationEmails as realGetInvitationEmails, getPublicMeetingUrl as realGetPublicMeetingUrl } from '../../../../../meeting.service.js';
import { getInAppMeetingLink } from '../../../../../../utils/meetingPublicUrl.js';
import { sendMeetingReminderEmail as realSendMeetingReminderEmail } from '../../../../../email.service.js';
import { notify as realNotify } from '../../../../../notification.service.js';
import { dispatchReminder as realDispatchReminder } from '../../../../../reminderDispatcher.js';
import { escapeRegex } from './common.js';

/**
 * One interview's reminder, using the same delivery the scheduler uses inside
 * sendUpcomingMeetingReminders (kind interviewT15: email + in-app).
 *
 * ponytail: that function has no single-meeting entry, so this repeats its per-meeting
 * deliver callback. Two confirms racing both send; the upgrade is exporting
 * sendInterviewReminderForMeeting from meeting.service and deleting this copy.
 */
export async function deliverInterviewReminder(meeting, deps = {}) {
  const getInvitationEmails = deps.getInvitationEmails ?? realGetInvitationEmails;
  const getPublicMeetingUrl = deps.getPublicMeetingUrl ?? realGetPublicMeetingUrl;
  const inAppLink = deps.getInAppMeetingLink ?? getInAppMeetingLink;
  const sendMeetingReminderEmail = deps.sendMeetingReminderEmail ?? realSendMeetingReminderEmail;
  const notify = deps.notify ?? realNotify;
  const dispatchReminder = deps.dispatchReminder ?? realDispatchReminder;
  const User = deps.User ?? UserModel;

  const emails = getInvitationEmails(meeting);
  const title = meeting.title || 'Interview';
  const message = `Your interview "${title}" starts soon.`;

  return dispatchReminder({
    kind: 'interviewT15',
    recipients: emails.map((email) => ({ email })),
    deliver: async ({ email }) => {
      const inviteName = inviteeName(meeting, email);
      const link = getPublicMeetingUrl(meeting.meetingId, { name: inviteName, email });
      const user = await User.findOne({
        email: new RegExp(`^${escapeRegex(email)}$`, 'i'),
      }).select('_id').lean();
      let notified = false;
      if (user?._id) {
        try {
          await notify(user._id, {
            type: 'meeting_reminder',
            title: 'Interview reminder',
            message,
            ...interviewNoticeFields(meeting, inAppLink, { name: inviteName, email }),
          });
          notified = true;
        } catch {
          // The scheduler logs and still tries email. A failed in-app notice is not a failed reminder.
        }
      }
      const emailed = await sendMeetingReminderEmail(email, {
        title,
        scheduledAt: meeting.scheduledAt,
        timezone: meeting.timezone || 'UTC',
        publicMeetingUrl: link,
        inviteeName,
      });
      return emailed || notified;
    },
  });
}

/** Same rules as meeting.service resolveInviteeDisplayName (not exported). */
function inviteeName(meeting, emailAddress) {
  if (!emailAddress || typeof emailAddress !== 'string') return 'Guest';
  const em = emailAddress.trim().toLowerCase();
  const host = (meeting.hosts || []).find((h) => h.email && String(h.email).trim().toLowerCase() === em);
  if (host?.nameOrRole && String(host.nameOrRole).trim()) return String(host.nameOrRole).trim();
  const cand = meeting.candidate;
  if (cand?.email && String(cand.email).trim().toLowerCase() === em) {
    const n = cand.name || cand.fullName;
    if (n && String(n).trim()) return String(n).trim();
  }
  const rec = meeting.recruiter;
  if (rec?.email && String(rec.email).trim().toLowerCase() === em && rec.name && String(rec.name).trim()) {
    return String(rec.name).trim();
  }
  return em.split('@')[0] || 'Guest';
}

/** Same shape as meeting.service interviewMeetingNotificationFields (not exported). */
function interviewNoticeFields(meeting, inAppLink, invite) {
  return {
    link: inAppLink(meeting.meetingId, invite),
    relatedEntity: { type: 'meeting', id: meeting.meetingId },
    metadata: { meetingId: meeting.meetingId, meetingKind: 'interview' },
  };
}
