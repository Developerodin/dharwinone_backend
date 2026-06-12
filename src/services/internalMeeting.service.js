import InternalMeeting from '../models/internalMeeting.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { sendMeetingInvitationEmail } from './email.service.js';
import logger from '../config/logger.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { deleteInterviewRoom } from './livekit.service.js';
import { getPublicMeetingUrl, getInAppMeetingLink } from '../utils/meetingPublicUrl.js';
import { internalMeetingScope } from './visibilityScope.service.js';

const internalMeetingNotificationFields = (meeting, invite = {}, extra = {}) => ({
  link: getInAppMeetingLink(meeting.meetingId, invite),
  relatedEntity: { type: 'meeting', id: meeting.meetingId },
  metadata: { meetingId: meeting.meetingId, meetingKind: 'internal', ...extra },
});

const resolveInviteeDisplayName = (meeting, emailAddress) => {
  if (!emailAddress || typeof emailAddress !== 'string') return 'Guest';
  const em = emailAddress.trim().toLowerCase();
  const hosts = meeting.hosts || [];
  const host = hosts.find((h) => h.email && String(h.email).trim().toLowerCase() === em);
  if (host?.nameOrRole && String(host.nameOrRole).trim()) return String(host.nameOrRole).trim();
  const local = em.split('@')[0];
  return local || 'Guest';
};

const formatMeetingScheduledLocal = (scheduledAt, timezone) => {
  if (!scheduledAt) return 'TBD';
  const tz = timezone && String(timezone).trim() ? String(timezone).trim() : 'UTC';
  try {
    return new Date(scheduledAt).toLocaleString('en-US', { timeZone: tz });
  } catch {
    return new Date(scheduledAt).toLocaleString('en-US');
  }
};

const getInvitationEmails = (meeting) => {
  const set = new Set();
  (meeting.hosts || []).forEach((h) => {
    if (h.email && h.email.trim()) set.add(h.email.trim().toLowerCase());
  });
  (meeting.emailInvites || []).forEach((email) => {
    if (email && String(email).trim()) set.add(String(email).trim().toLowerCase());
  });
  return [...set];
};

const resolveInternalByIdOrMeetingId = async (id) => {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
    return InternalMeeting.findById(trimmed);
  }
  return InternalMeeting.findOne({ meetingId: trimmed });
};

/**
 * Send the meeting invitation email + in-app notification to each recipient.
 * Shared by create (all recipients) and update (only newly-added recipients).
 * @param {Object} meeting - InternalMeeting document
 * @param {string[]} emails - lowercased recipient emails
 */
const sendInvitationEmails = (meeting, emails) => {
  const scheduled = formatMeetingScheduledLocal(meeting.scheduledAt, meeting.timezone);
  const hostName = meeting.hosts?.[0]?.nameOrRole || '';
  emails.forEach((to) => {
    const inviteName = resolveInviteeDisplayName(meeting, to);
    const personalUrl = getPublicMeetingUrl(meeting.meetingId, { name: inviteName, email: to });
    const payload = {
      title: meeting.title,
      scheduledAt: meeting.scheduledAt,
      timezone: meeting.timezone,
      durationMinutes: meeting.durationMinutes,
      inviteeName: inviteName,
      hostName,
      interviewType: meeting.meetingType,
      jobPosition: '',
      description: meeting.description,
      publicMeetingUrl: personalUrl,
    };
    sendMeetingInvitationEmail(to, payload).catch((err) => {
      logger.warn(`Failed to send internal meeting invitation to ${to}:`, err?.message || err);
    });
    import('./notification.service.js')
      .then(({ notifyByEmail }) => {
        notifyByEmail(to, {
          type: 'meeting',
          title: meeting.title || 'Meeting invitation',
          message: `Scheduled: ${scheduled}`,
          ...internalMeetingNotificationFields(meeting, { name: inviteName, email: to }),
        }).catch(() => {});
      })
      .catch(() => {});
  });
};

/**
 * @param {Object} body
 * @param {string} userId
 */
const createInternalMeeting = async (body, userId) => {
  const meetingId = await generateUniqueLivekitRoomId();
  const durationMinutes = Number(body.durationMinutes) || 60;
  const meeting = await InternalMeeting.create({
    ...body,
    durationMinutes,
    meetingId,
    roomName: meetingId,
    createdBy: userId,
  });

  const meetingObj = meeting.toJSON();
  meetingObj.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);

  // Send invitation emails to everyone (fire-and-forget; log errors)
  sendInvitationEmails(meeting, getInvitationEmails(meeting));

  return meetingObj;
};

const queryInternalMeetings = async (filter, options, currentUser = null) => {
  let scopedFilter = filter;
  if (currentUser) {
    const { filter: scope } = await internalMeetingScope(currentUser, 'read');
    scopedFilter = { $and: [filter || {}, scope] };
  }
  const result = await InternalMeeting.paginate(scopedFilter, {
    ...options,
    populate: 'createdBy',
    sort: options.sortBy || '-createdAt',
  });
  result.results = (result.results || []).map((m) => {
    const doc = m.toJSON ? m.toJSON() : m;
    doc.publicMeetingUrl = getPublicMeetingUrl(doc.meetingId);
    return doc;
  });
  return result;
};

const getInternalMeetingById = async (id, currentUser = null) => {
  const meeting = await resolveInternalByIdOrMeetingId(id);
  if (!meeting) return null;
  // Prevent by-id enumeration across the meetings.* boundary. No-op for trusted
  // internal calls (currentUser absent), e.g. the update flow re-fetch.
  if (currentUser) {
    const { filter: scope } = await internalMeetingScope(currentUser, 'read');
    const inScope = await InternalMeeting.exists({ $and: [{ _id: meeting._id }, scope] });
    if (!inScope) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const populated = await InternalMeeting.findById(meeting._id).populate('createdBy');
  if (!populated) return null;
  const doc = populated.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(populated.meetingId);
  return doc;
};

const updateInternalMeetingById = async (id, updateBody) => {
  const meeting = await resolveInternalByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  // Snapshot recipients before the edit so we email only newly-added invitees.
  const beforeInviteEmails = new Set(getInvitationEmails(meeting));
  const safeBody = { ...updateBody };
  const dur = Number(safeBody.durationMinutes);
  if (Number.isInteger(dur) && dur >= 1 && dur <= 480) {
    safeBody.durationMinutes = dur;
  } else if ('durationMinutes' in safeBody) {
    delete safeBody.durationMinutes;
  }
  Object.assign(meeting, safeBody);
  await meeting.save();

  // Email ONLY the newly-added invitees/participants (no re-spam on edit).
  const newlyAddedEmails = getInvitationEmails(meeting).filter((e) => !beforeInviteEmails.has(e));
  if (newlyAddedEmails.length) sendInvitationEmails(meeting, newlyAddedEmails);

  return getInternalMeetingById(meeting._id.toString());
};

const deleteInternalMeetingById = async (id) => {
  const meeting = await InternalMeeting.findById(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await meeting.deleteOne();
  return meeting;
};

const resendInternalMeetingInvitations = async (id) => {
  const meeting = await InternalMeeting.findById(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const emails = getInvitationEmails(meeting);
  const scheduled = formatMeetingScheduledLocal(meeting.scheduledAt, meeting.timezone);
  let sent = 0;
  const { notifyByEmail } = await import('./notification.service.js');
  const hostName = meeting.hosts?.[0]?.nameOrRole || '';

  await Promise.all(
    emails.map((to) => {
      const inviteName = resolveInviteeDisplayName(meeting, to);
      const personalUrl = getPublicMeetingUrl(meeting.meetingId, { name: inviteName, email: to });
      const payload = {
        title: meeting.title,
        scheduledAt: meeting.scheduledAt,
        timezone: meeting.timezone,
        durationMinutes: meeting.durationMinutes,
        inviteeName: inviteName,
        hostName,
        interviewType: meeting.meetingType,
        jobPosition: '',
        description: meeting.description,
        publicMeetingUrl: personalUrl,
      };
      return sendMeetingInvitationEmail(to, payload)
        .then(() => {
          sent += 1;
        })
        .catch((err) => {
          logger.warn(`Failed to resend internal meeting invitation to ${to}:`, err?.message || err);
        });
    })
  );

  emails.forEach((to) => {
    const inviteName = resolveInviteeDisplayName(meeting, to);
    const personalUrl = getPublicMeetingUrl(meeting.meetingId, { name: inviteName, email: to });
    notifyByEmail(to, {
      type: 'meeting',
      title: meeting.title || 'Meeting invitation',
      message: `Scheduled: ${scheduled}`,
      ...internalMeetingNotificationFields(meeting, { name: inviteName, email: to }),
    }).catch(() => {});
  });

  return { sent };
};

const endInternalMeetingByRoomPublic = async (roomName, hostEmail) => {
  const meeting = await InternalMeeting.findOne({ meetingId: roomName });
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const emailLower = (hostEmail || '').toLowerCase().trim();
  const isHost = meeting.hosts?.some((h) => (h.email || '').toLowerCase().trim() === emailLower);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only a host can end the meeting');
  }
  meeting.status = 'ended';
  await meeting.save();
  // Stop egress + wait for finalization, then evict participants + delete LiveKit room.
  // Without this, recording was orphaned in EGRESS_ACTIVE and S3 upload never finalized.
  try {
    await deleteInterviewRoom(roomName);
  } catch (err) {
    logger.warn('[endInternalMeetingByRoomPublic] LiveKit deleteInterviewRoom failed', { roomName, err: err?.message || err });
  }
  const doc = meeting.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
  return doc;
};

const autoEndExpiredInternalMeetings = async () => {
  const now = new Date();
  const meetings = await InternalMeeting.find({
    status: 'scheduled',
    $expr: {
      $lte: [{ $add: ['$scheduledAt', { $multiply: ['$durationMinutes', 60000] }] }, now],
    },
  }).lean();

  let count = 0;
  for (const m of meetings) {
    try {
      await InternalMeeting.updateOne({ _id: m._id }, { status: 'ended' });
      // Mirror Meeting.autoEndExpiredMeetings: stop egress + wait for finalize before
      // deleting LiveKit room. Skipping this step is what kept recordings stuck in
      // EGRESS_ACTIVE for internal meetings until the 8h cron force-resolved them.
      await deleteInterviewRoom(m.meetingId).catch((err) =>
        logger.warn(`[autoEndExpiredInternalMeetings] LiveKit delete failed ${m.meetingId}:`, err?.message || err)
      );
      count += 1;
      logger.info(`[autoEndExpiredInternalMeetings] Auto-ended internal meeting ${m.meetingId} (${m.title})`);
    } catch (err) {
      logger.warn(`[autoEndExpiredInternalMeetings] Failed to end ${m.meetingId}:`, err?.message || err);
    }
  }
  return count;
};

/**
 * Config-driven reminder windows (lead minutes before each meeting). Override via
 * env INTERNAL_MEETING_REMINDER_WINDOWS="60,15". Adding a window (e.g. "1440,240,60,15"
 * for 24h/4h/1h/15m) needs no code change. Each window dedups independently via the
 * reminderState map keyed by lead-minutes.
 */
export const REMINDER_WINDOWS = (() => {
  const raw = process.env.INTERNAL_MEETING_REMINDER_WINDOWS;
  const mins = raw
    ? raw
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [60, 15];
  const label = (m) => (m % 60 === 0 ? `${m / 60} hour${m / 60 > 1 ? 's' : ''}` : `${m} minutes`);
  return mins.map((m) => ({ minutes: m, label: label(m) }));
})();

// Half-width of the match window (minutes). With a 5-min scheduler tick a ~±5
// window guarantees each meeting is caught once; reminderState prevents double-fire.
const WINDOW_PAD_MIN = Math.max(2, Number(process.env.INTERNAL_MEETING_REMINDER_PAD_MIN) || 5);

const sendInternalMeetingRemindersForWindow = async ({ minutes, label }) => {
  const now = new Date();
  const center = now.getTime() + minutes * 60 * 1000;
  const windowStart = new Date(center - WINDOW_PAD_MIN * 60 * 1000);
  const windowEnd = new Date(center + WINDOW_PAD_MIN * 60 * 1000);
  const stateField = `reminderState.${minutes}`;

  const filter = {
    status: 'scheduled',
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
    [stateField]: { $exists: false },
  };
  // Back-compat: pre-existing one-off meetings used `reminderSentAt` for the 15-min mark.
  if (minutes === 15) filter.reminderSentAt = null;
  const meetings = await InternalMeeting.find(filter).lean();
  if (!meetings.length) return;

  const User = (await import('../models/user.model.js')).default;
  const { notify } = await import('./notification.service.js');

  for (const m of meetings) {
    const claimFilter = { _id: m._id, [stateField]: { $exists: false } };
    const claimSet = { [stateField]: now };
    if (minutes === 15) {
      claimFilter.reminderSentAt = null;
      claimSet.reminderSentAt = now;
    }
    const result = await InternalMeeting.updateOne(claimFilter, { $set: claimSet });
    if (result.modifiedCount === 0) continue; // another tick/process claimed it

    const emails = getInvitationEmails(m);
    const title = m.title || 'Meeting';
    const message = `Your meeting "${title}" starts in ${label}.`;
    const remindedUserIds = new Set();
    for (const email of emails) {
      const inviteName = resolveInviteeDisplayName(m, email);
      const publicUrl = getPublicMeetingUrl(m.meetingId, { name: inviteName, email });
      const user = await User.findOne({
        email: new RegExp(`^${String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      })
        .select('_id')
        .lean();
      const uid = user?._id ? String(user._id) : '';
      if (user && uid && !remindedUserIds.has(uid)) {
        remindedUserIds.add(uid);
        notify(user._id, {
          type: 'meeting_reminder',
          title: 'Meeting reminder',
          message,
          ...internalMeetingNotificationFields(m, { name: inviteName, email }),
          email: {
            subject: `Reminder: ${title} starts soon`,
            text: `${message}\n\n${publicUrl}`,
          },
        }).catch(() => {});
      }
    }
  }
};

export const sendUpcomingInternalMeetingReminders = async () => {
  for (const w of REMINDER_WINDOWS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendInternalMeetingRemindersForWindow(w);
    } catch (err) {
      logger.warn(`[internalMeetingReminders] window ${w.minutes}m failed: ${err?.message || err}`);
    }
  }
};

export {
  createInternalMeeting,
  queryInternalMeetings,
  getInternalMeetingById,
  updateInternalMeetingById,
  deleteInternalMeetingById,
  resendInternalMeetingInvitations,
  endInternalMeetingByRoomPublic,
  autoEndExpiredInternalMeetings,
};
