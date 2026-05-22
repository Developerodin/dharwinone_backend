import InternalMeeting from '../models/internalMeeting.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { sendMeetingInvitationEmail } from './email.service.js';
import logger from '../config/logger.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { deleteInterviewRoom } from './livekit.service.js';
import { getPublicMeetingUrl, getInAppMeetingLink } from '../utils/meetingPublicUrl.js';

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

  const emails = getInvitationEmails(meeting);
  const scheduled = meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleString() : 'TBD';
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

  return meetingObj;
};

const queryInternalMeetings = async (filter, options) => {
  const result = await InternalMeeting.paginate(filter, {
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

const getInternalMeetingById = async (id) => {
  const meeting = await resolveInternalByIdOrMeetingId(id);
  if (!meeting) return null;
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
  const safeBody = { ...updateBody };
  const dur = Number(safeBody.durationMinutes);
  if (Number.isInteger(dur) && dur >= 1 && dur <= 480) {
    safeBody.durationMinutes = dur;
  } else if ('durationMinutes' in safeBody) {
    delete safeBody.durationMinutes;
  }
  Object.assign(meeting, safeBody);
  await meeting.save();
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
  const scheduled = meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleString() : 'TBD';
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

export const sendUpcomingInternalMeetingReminders = async () => {
  const now = new Date();
  const windowStart = new Date(now.getTime() + 10 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 20 * 60 * 1000);
  const meetings = await InternalMeeting.find({
    status: 'scheduled',
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
    reminderSentAt: null,
  }).lean();

  const User = (await import('../models/user.model.js')).default;
  const { notify } = await import('./notification.service.js');

  for (const m of meetings) {
    const result = await InternalMeeting.updateOne(
      { _id: m._id, reminderSentAt: null },
      { $set: { reminderSentAt: now } }
    );
    if (result.modifiedCount === 0) continue;

    const emails = getInvitationEmails(m);
    const title = m.title || 'Meeting';
    const message = `Your meeting "${title}" starts in 15 minutes.`;
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
