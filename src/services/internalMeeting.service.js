import InternalMeeting from '../models/internalMeeting.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { sendMeetingInvitationEmail } from './email.service.js';
import logger from '../config/logger.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { deleteInterviewRoom } from './livekit.service.js';
import { getPublicMeetingUrl, getInAppMeetingLink } from '../utils/meetingPublicUrl.js';
import { internalMeetingScope, resolveActorEmails } from './visibilityScope.service.js';

const internalMeetingNotificationFields = (meeting, invite = {}, extra = {}) => ({
  link: getInAppMeetingLink(meeting.meetingId, invite),
  relatedEntity: { type: 'meeting', id: meeting.meetingId },
  metadata: { meetingId: meeting.meetingId, meetingKind: 'internal', ...extra },
});

const normalizeEmail = (value) => String(value || '').toLowerCase().trim();

/** Prefer the invite email that matches the actor (company or login) for personal join links. */
const pickActorJoinIdentity = (meeting, actor = {}, actorEmails = []) => {
  const emailSet = new Set((actorEmails || []).map(normalizeEmail).filter(Boolean));
  let joinEmail = '';
  for (const h of meeting.hosts || []) {
    const e = normalizeEmail(h?.email);
    if (e && emailSet.has(e)) {
      joinEmail = e;
      break;
    }
  }
  if (!joinEmail) {
    for (const raw of meeting.emailInvites || []) {
      const e = normalizeEmail(raw);
      if (e && emailSet.has(e)) {
        joinEmail = e;
        break;
      }
    }
  }
  if (!joinEmail) joinEmail = normalizeEmail(actor.email) || [...emailSet][0] || '';
  const name =
    (typeof actor.name === 'string' && actor.name.trim()) ||
    resolveInviteeDisplayName(meeting, joinEmail);
  return { name, email: joinEmail };
};

const withPublicMeetingUrl = (doc, actor = null, actorEmails = []) => {
  if (!doc) return doc;
  if (actor) {
    const invite = pickActorJoinIdentity(doc, actor, actorEmails);
    doc.publicMeetingUrl = getPublicMeetingUrl(doc.meetingId, invite);
  } else {
    doc.publicMeetingUrl = getPublicMeetingUrl(doc.meetingId);
  }
  return doc;
};

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
      allowGuestJoin: meeting.allowGuestJoin,
      requireApproval: meeting.requireApproval,
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
  const hosts = (body.hosts || []).map((h) => ({
    ...h,
    email: String(h?.email || '').trim().toLowerCase(),
  }));
  const emailInvites = (body.emailInvites || [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);
  const meeting = await InternalMeeting.create({
    ...body,
    hosts,
    emailInvites,
    durationMinutes,
    meetingId,
    roomName: meetingId,
    createdBy: userId,
    reminders: buildReminderSchedule(body.scheduledAt),
  });

  const meetingObj = meeting.toJSON();
  meetingObj.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);

  // Send invitation emails to everyone (fire-and-forget; log errors)
  sendInvitationEmails(meeting, getInvitationEmails(meeting));

  return meetingObj;
};

const queryInternalMeetings = async (filter, options, currentUser = null) => {
  let scopedFilter = filter;
  let actorEmails = [];
  if (currentUser) {
    const { filter: scope } = await internalMeetingScope(currentUser, 'read');
    scopedFilter = { $and: [filter || {}, scope] };
    actorEmails = await resolveActorEmails(currentUser);
  }
  const result = await InternalMeeting.paginate(scopedFilter, {
    ...options,
    populate: 'createdBy',
    sort: options.sortBy || '-scheduledAt',
  });
  result.results = (result.results || []).map((m) => {
    const doc = m.toJSON ? m.toJSON() : m;
    return withPublicMeetingUrl(doc, currentUser, actorEmails);
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
  const actorEmails = currentUser ? await resolveActorEmails(currentUser) : [];
  return withPublicMeetingUrl(doc, currentUser, actorEmails);
};

const updateInternalMeetingById = async (id, updateBody) => {
  const meeting = await resolveInternalByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const previousStatus = meeting.status;
  // Snapshot recipients before the edit so we email only newly-added invitees.
  const beforeInviteEmails = new Set(getInvitationEmails(meeting));
  const safeBody = { ...updateBody };
  if (Array.isArray(safeBody.hosts)) {
    safeBody.hosts = safeBody.hosts.map((h) => ({
      ...h,
      email: String(h?.email || '').trim().toLowerCase(),
    }));
  }
  if (Array.isArray(safeBody.emailInvites)) {
    safeBody.emailInvites = safeBody.emailInvites
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(Boolean);
  }
  const dur = Number(safeBody.durationMinutes);
  if (Number.isInteger(dur) && dur >= 1 && dur <= 480) {
    safeBody.durationMinutes = dur;
  } else if ('durationMinutes' in safeBody) {
    delete safeBody.durationMinutes;
  }
  const previousScheduledAt = meeting.scheduledAt;
  Object.assign(meeting, safeBody);
  // Same reasoning as updateMeetingById: every claimed reminder window refers to the old
  // start time, so clear them all and let the scheduler re-catch the new one.
  const movedTo = meeting.scheduledAt;
  if (
    previousScheduledAt &&
    movedTo &&
    new Date(previousScheduledAt).getTime() !== new Date(movedTo).getTime()
  ) {
    meeting.reminderSentAt = null;
    meeting.reminderState = new Map();
    meeting.reminders = buildReminderSchedule(movedTo);
  }
  if (previousStatus !== 'ended' && meeting.status === 'ended') {
    meeting.endedAt = new Date();
  } else if (previousStatus === 'ended' && meeting.status !== 'ended') {
    meeting.endedAt = null;
  }
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
        allowGuestJoin: meeting.allowGuestJoin,
        requireApproval: meeting.requireApproval,
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
  meeting.endedAt = new Date();
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
      await InternalMeeting.updateOne({ _id: m._id }, { status: 'ended', endedAt: now });
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
 * Reminder lead times, in minutes before the start. Override via
 * env INTERNAL_MEETING_REMINDER_WINDOWS="60,10". A value added here is materialised onto
 * meetings created afterwards; meetings that already exist keep the schedule they were
 * created with, so changing this never retro-fires and never duplicates an existing one.
 */
export const REMINDER_WINDOWS = (() => {
  const raw = process.env.INTERNAL_MEETING_REMINDER_WINDOWS;
  const mins = raw
    ? raw
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [60, 10];
  return [...new Set(mins)].sort((a, b) => b - a);
})();

export const formatLeadLabel = (m) => (m % 60 === 0 ? `${m / 60} hour${m / 60 > 1 ? 's' : ''}` : `${m} minutes`);

/**
 * Materialise the reminder schedule for a start time: one entry per configured lead time,
 * each with the exact moment it becomes due.
 *
 * Entries already past at this moment are dropped. A meeting booked inside its own lead
 * time has no earlier moment left to fire — the invitation going out right now is the
 * notice — and creating one anyway is what made a reminder land seconds after booking.
 *
 * @param {Date|string} scheduledAt
 * @param {Date} [now]
 * @returns {Array<{leadMinutes:number, dueAt:Date, sentAt:null}>}
 */
export const buildReminderSchedule = (scheduledAt, now = new Date()) => {
  if (!scheduledAt) return [];
  const start = new Date(scheduledAt).getTime();
  if (!Number.isFinite(start)) return [];
  return REMINDER_WINDOWS.map((leadMinutes) => ({
    leadMinutes,
    dueAt: new Date(start - leadMinutes * 60000),
    sentAt: null,
  })).filter((r) => r.dueAt.getTime() > now.getTime());
};

/**
 * Send one due reminder entry. The entry is claimed before delivery, so two schedulers
 * racing the same meeting settle it in the database rather than both mailing.
 */
const sendDueInternalMeetingReminder = async (m, entry, now) => {
  const minutes = entry.leadMinutes;
  const label = formatLeadLabel(minutes);
  const claimFilter = {
    _id: m._id,
    reminders: { $elemMatch: { leadMinutes: minutes, sentAt: null } },
    // Refuse a window the previous band-matching code already sent. Backfilled meetings
    // carry unsent entries whose due moment may pass while the old code is still deployed:
    // it reminds via reminderState, and without this the new pass would remind again.
    [`reminderState.${minutes}`]: { $exists: false },
  };
  // The legacy dedup fields are written alongside the claim so a process still running the
  // previous band-matching code treats this meeting as already reminded mid-rollout.
  const claimSet = {
    'reminders.$.sentAt': now,
    [`reminderState.${minutes}`]: now,
    reminderSentAt: now,
  };
  const result = await InternalMeeting.updateOne(claimFilter, { $set: claimSet });
  if (result.modifiedCount === 0) return; // another tick or process claimed it

  // A reminder for a meeting that already started is not worth sending: a scheduler that
  // was down should not deliver "starts soon" after the fact. The claim above retires it.
  if (new Date(m.scheduledAt).getTime() <= now.getTime()) {
    logger.info(
      `[internalMeetingReminders] ${m.meetingId} ${minutes}m suppressed — meeting already started`
    );
    return;
  }

  const User = (await import('../models/user.model.js')).default;
  const { notify } = await import('./notification.service.js');
  const { sendMeetingReminderEmail, buildMeetingReminderEmail } = await import('./email.service.js');

    let delivered = 0;
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
        try {
          // eslint-disable-next-line no-await-in-loop
          await notify(user._id, {
            type: 'meeting_reminder',
            title: 'Meeting reminder',
            message,
            ...internalMeetingNotificationFields(m, { name: inviteName, email }),
            // Same builder the guest branch uses, so an invitee with an account and one
            // without receive the identical templated mail. Passing only `text` here is
            // what produced the bare, unstyled reminder: notify() sends `html` only when
            // it is given one.
            email: buildMeetingReminderEmail({
              title,
              scheduledAt: m.scheduledAt,
              timezone: m.timezone || 'UTC',
              publicMeetingUrl: publicUrl,
              inviteeName: inviteName,
              kindLabel: 'meeting',
            }),
          });
          delivered += 1;
        } catch (err) {
          logger.warn(
            `[internalMeetingReminders] ${m.meetingId} ${minutes}m notify failed for ${email}: ${err?.message || err}`
          );
        }
      } else if (!user) {
        // Invitees who are not system users — external guests — got nothing at all before
        // this branch existed. ATS interviews have always emailed them; internal meetings
        // now match. Addressed to the invited address, not to a User record's email.
        try {
          // eslint-disable-next-line no-await-in-loop
          const sent = await sendMeetingReminderEmail(email, {
            title,
            scheduledAt: m.scheduledAt,
            timezone: m.timezone || 'UTC',
            publicMeetingUrl: publicUrl,
            inviteeName: inviteName,
            kindLabel: 'meeting',
          });
          if (sent) delivered += 1;
        } catch (err) {
          logger.warn(
            `[internalMeetingReminders] ${m.meetingId} ${minutes}m guest email failed for ${email}: ${err?.message || err}`
          );
        }
      }
    }

  if (delivered === 0) {
    // Nothing reached anyone, so hand the entry back: it stays due and the next tick retries
    // it. There is no window to fall out of any more, so a transient SMTP failure no longer
    // loses the reminder outright. Ceiling: a process killed between claim and send still
    // loses this one — closing that needs the claimedAt lease the ATS pass carries.
    await InternalMeeting.updateOne(
      { _id: m._id, reminders: { $elemMatch: { leadMinutes: minutes, sentAt: now } } },
      {
        $set: { 'reminders.$.sentAt': null, reminderSentAt: null },
        $unset: { [`reminderState.${minutes}`]: '' },
      }
    );
    logger.warn(
      `[internalMeetingReminders] ${m.meetingId} ${minutes}m reached nobody (${emails.length} invitee(s)) — claim released`
    );
  }
};

export { sendDueInternalMeetingReminder };

/**
 * One pass over every reminder that has come due. Selection is by due time, not by matching
 * the start time against a moving band, so a reminder cannot be missed by a late tick.
 */
export const sendUpcomingInternalMeetingReminders = async () => {
  const now = new Date();
  const meetings = await InternalMeeting.find({
    status: 'scheduled',
    reminders: { $elemMatch: { sentAt: null, dueAt: { $lte: now } } },
  })
    .limit(200)
    .lean();

  for (const m of meetings) {
    const due = (m.reminders || []).filter(
      (r) => !r.sentAt && new Date(r.dueAt).getTime() <= now.getTime()
    );
    for (const entry of due) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sendDueInternalMeetingReminder(m, entry, now);
      } catch (err) {
        logger.warn(
          `[internalMeetingReminders] ${m.meetingId} ${entry.leadMinutes}m failed: ${err?.message || err}`
        );
      }
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
