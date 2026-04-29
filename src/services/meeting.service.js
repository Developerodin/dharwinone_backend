import mongoose from 'mongoose';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Job from '../models/job.model.js';
import Offer from '../models/offer.model.js';
import Placement from '../models/placement.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { sendMeetingInvitationEmail } from './email.service.js';
import logger from '../config/logger.js';
import * as offerService from './offer.service.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { getPublicMeetingUrl } from '../utils/meetingPublicUrl.js';
import { getMeetingByMeetingId } from './meetingLookup.service.js';
import { deleteInterviewRoom } from './livekit.service.js';
import { syncReferralPipelineStatusForCandidate } from './referralLeads.service.js';

/**
 * Display name for join link / email (hosts, candidate, recruiter, or email local-part).
 * @param {Object} meeting - Meeting doc or plain object
 * @param {string} emailAddress
 * @returns {string}
 */
const resolveInviteeDisplayName = (meeting, emailAddress) => {
  if (!emailAddress || typeof emailAddress !== 'string') return 'Guest';
  const em = emailAddress.trim().toLowerCase();
  const hosts = meeting.hosts || [];
  const host = hosts.find((h) => h.email && String(h.email).trim().toLowerCase() === em);
  if (host?.nameOrRole && String(host.nameOrRole).trim()) return String(host.nameOrRole).trim();
  const cand = meeting.candidate;
  if (cand?.email && String(cand.email).trim().toLowerCase() === em) {
    const n = cand.name || cand.fullName;
    if (n && String(n).trim()) return String(n).trim();
  }
  const rec = meeting.recruiter;
  if (rec?.email && String(rec.email).trim().toLowerCase() === em) {
    if (rec.name && String(rec.name).trim()) return String(rec.name).trim();
  }
  const local = em.split('@')[0];
  return local || 'Guest';
};

/**
 * Collect all unique emails to send invitation to (hosts + emailInvites + optional candidate/recruiter)
 * @param {Object} meeting
 * @returns {string[]}
 */
const getInvitationEmails = (meeting) => {
  const set = new Set();
  (meeting.hosts || []).forEach((h) => {
    if (h.email && h.email.trim()) set.add(h.email.trim().toLowerCase());
  });
  (meeting.emailInvites || []).forEach((email) => {
    if (email && String(email).trim()) set.add(String(email).trim().toLowerCase());
  });
  if (meeting.candidate?.email && meeting.candidate.email.trim()) {
    set.add(meeting.candidate.email.trim().toLowerCase());
  }
  if (meeting.recruiter?.email && meeting.recruiter.email.trim()) {
    set.add(meeting.recruiter.email.trim().toLowerCase());
  }
  return [...set];
};

/**
 * Create a meeting and send invitation emails
 * @param {Object} body - Meeting payload
 * @param {string} userId - Created by user id
 * @returns {Promise<Object>} Meeting with publicMeetingUrl
 */
const createMeeting = async (body, userId) => {
  const meetingId = await generateUniqueLivekitRoomId();
  const durationMinutes = Number(body.durationMinutes) || 60;
  const meeting = await Meeting.create({
    ...body,
    durationMinutes,
    meetingId,
    roomName: meetingId, // same as meetingId for LiveKit; satisfies legacy index roomName_1
    createdBy: userId,
  });

  const meetingObj = meeting.toJSON();
  meetingObj.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);

  // Update JobApplication to Interview when scheduling (candidate + job present)
  const candId = meeting.candidate?.id;
  const jobPos = (meeting.jobPosition || '').trim();
  if (candId && mongoose.Types.ObjectId.isValid(candId) && jobPos) {
    let jobObjId = null;
    if (/^[0-9a-fA-F]{24}$/.test(jobPos)) {
      jobObjId = new mongoose.Types.ObjectId(jobPos);
    } else {
      const j = await Job.findOne({ title: { $regex: new RegExp(`^${jobPos.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }).select('_id').lean();
      jobObjId = j?._id;
    }
    if (jobObjId) {
      try {
        const ur = await JobApplication.updateOne(
          {
            candidate: new mongoose.Types.ObjectId(candId),
            job: jobObjId,
            status: { $in: ['Applied', 'Screening'] },
          },
          { status: 'Interview' }
        );
        if (ur.modifiedCount > 0) {
          await syncReferralPipelineStatusForCandidate(candId).catch((err) =>
            logger.warn('referral pipeline sync after interview schedule:', err?.message || err)
          );
        }
      } catch (err) {
        logger.warn('Failed to update JobApplication to Interview:', err?.message || err);
      }
    }
  }

  // Send invitation emails (fire-and-forget; log errors)
  const emails = getInvitationEmails(meeting);
  const scheduled = meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleString() : 'TBD';
  emails.forEach((to) => {
    const inviteName = resolveInviteeDisplayName(meeting, to);
    const personalUrl = getPublicMeetingUrl(meeting.meetingId, { name: inviteName, email: to });
    const payload = {
      title: meeting.title,
      scheduledAt: meeting.scheduledAt,
      timezone: meeting.timezone,
      durationMinutes: meeting.durationMinutes,
      inviteeName: inviteName,
      hostName: meeting.recruiter?.name || meeting.hosts?.[0]?.nameOrRole || '',
      interviewType: meeting.interviewType,
      jobPosition: meeting.jobPosition,
      description: meeting.description,
      publicMeetingUrl: personalUrl,
    };
    sendMeetingInvitationEmail(to, payload).catch((err) => {
      logger.warn(`Failed to send meeting invitation to ${to}:`, err?.message || err);
    });
    import('./notification.service.js').then(({ notifyByEmail }) => {
      notifyByEmail(to, {
        type: 'meeting',
        title: meeting.title || 'Meeting invitation',
        message: `Scheduled: ${scheduled}`,
        link: personalUrl,
      }).catch(() => {});
    }).catch(() => {});
  });

  return meetingObj;
};

/**
 * Query meetings with filter and pagination
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<QueryResult>}
 */
const queryMeetings = async (filter, options) => {
  const result = await Meeting.paginate(filter, {
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

/**
 * Get meeting by id (MongoDB ObjectId or meetingId string)
 * @param {string} id - MongoDB ObjectId (24 hex) or meetingId (e.g. meeting_xxx)
 * @returns {Promise<Meeting|null>}
 */
const getMeetingById = async (id) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) return null;
  const populated = await Meeting.findById(meeting._id).populate('createdBy');
  if (!populated) return null;
  const doc = populated.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(populated.meetingId);
  return doc;
};

/**
 * Resolve id (MongoDB ObjectId or meetingId string) to a meeting document
 * @param {string} id - MongoDB ObjectId (24 hex) or meetingId (e.g. meeting_xxx)
 * @returns {Promise<Meeting|null>}
 */
const resolveMeetingByIdOrMeetingId = async (id) => {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
    return Meeting.findById(trimmed);
  }
  return Meeting.findOne({ meetingId: trimmed });
};

const DEFAULT_OFFER_JOINING_DAYS = 30;

const defaultJoiningDateForInterviewOffer = () => {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_OFFER_JOINING_DAYS);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * Ensure joining date, then Draft → Sent → Accepted (placement).
 * Candidate offer-letter email is not sent automatically; recruiters send it from the Offer Letter Generator.
 * @param {import('mongoose').Types.ObjectId|string} offerId
 * @param {string} userId
 */
const emailOfferLetterAndCompletePlacement = async (offerId, userId) => {
  const actor = { id: userId, _id: userId };
  const id = offerId.toString();
  let offer = await offerService.getOfferById(id, null);
  if (!offer) {
    logger.warn('[emailOfferLetterAndCompletePlacement] Offer not found %s', id);
    return;
  }
  if (offer.status === 'Accepted') {
    return;
  }

  if (!offer.joiningDate) {
    await offerService.updateOfferById(
      id,
      { joiningDate: defaultJoiningDateForInterviewOffer() },
      actor,
      { skipAccessCheck: true }
    );
    offer = await offerService.getOfferById(id, null);
  }

  const fresh = await offerService.getOfferById(id, null);
  if (fresh?.status === 'Accepted') {
    return;
  }
  if (fresh?.status === 'Draft') {
    await offerService.updateOfferById(id, { status: 'Sent' }, actor, {
      skipAccessCheck: true,
      skipSentNotification: true,
    });
  }
  await offerService.updateOfferById(id, { status: 'Accepted' }, actor, { skipAccessCheck: true });
};

/**
 * [ADR] createPlacementFromInterview: creates offer + accepted placement from interview — not "completing"
 * pre-boarding tasks. Both recruiter accept and this path should end with the same Offer/Placement/Employee invariants.
 * @deprecated use createPlacementFromInterview name; `moveCandidateToPreboarding` is a backward-compatible alias.
 * Move employee to preboarding when interview result is "selected".
 * Creates an offer, then Sent → Accepted (placement Pending). Candidate offer email is sent from Offer Letter Generator.
 * @param {Object} meeting - Meeting document (after save)
 * @param {string} userId - User performing the action
 */
const createPlacementFromInterview = async (meeting, userId) => {
  const candidateId = meeting.candidate?.id;
  if (!candidateId || !mongoose.Types.ObjectId.isValid(candidateId)) {
    logger.warn('[createPlacementFromInterview] No valid candidate id on meeting %s', meeting._id);
    return;
  }

  const candidateObjId = new mongoose.Types.ObjectId(candidateId);
  let jobId = null;
  const jobPositionVal = (meeting.jobPosition || meeting.title || '').trim();

  if (/^[0-9a-fA-F]{24}$/.test(jobPositionVal)) {
    jobId = jobPositionVal;
  } else if (jobPositionVal) {
    const job = await Job.findOne({ title: { $regex: new RegExp(`^${jobPositionVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } })
      .select('_id')
      .lean();
    jobId = job?._id?.toString() || null;
  }

  let application = null;
  if (jobId) {
    application = await JobApplication.findOne({
      candidate: candidateObjId,
      job: new mongoose.Types.ObjectId(jobId),
      status: { $in: ['Applied', 'Screening', 'Interview'] },
    });
  }
  if (!application) {
    application = await JobApplication.findOne({
      candidate: candidateObjId,
      status: 'Interview',
    }).sort({ updatedAt: -1 });
  }
  if (!application && !jobId) {
    const appByCandidate = await JobApplication.findOne({
      candidate: candidateObjId,
      status: { $in: ['Applied', 'Screening'] },
    })
      .sort({ updatedAt: -1 })
      .populate('job', '_id title');
    if (appByCandidate) {
      application = appByCandidate;
      jobId = application.job?._id?.toString();
    }
  }
  if (!application && jobId) {
    try {
      const existing = await JobApplication.findOne({
        candidate: candidateObjId,
        job: new mongoose.Types.ObjectId(jobId),
      });
      if (existing && ['Applied', 'Screening', 'Interview'].includes(existing.status)) {
        application = existing;
      } else if (!existing) {
        application = await JobApplication.create({
          job: new mongoose.Types.ObjectId(jobId),
          candidate: candidateObjId,
          status: 'Interview',
        });
        logger.info('[createPlacementFromInterview] Created JobApplication for candidate %s + job %s', candidateId, jobId);
      }
    } catch (err) {
      logger.warn('[createPlacementFromInterview] Could not create JobApplication:', err?.message || err);
      return;
    }
  }

  if (!application) {
    logger.warn('[createPlacementFromInterview] No job application for meeting %s (candidate %s)', meeting._id, candidateId);
    return;
  }

  const existingOffer = await Offer.findOne({ jobApplication: application._id });
  if (existingOffer) {
    if (existingOffer.status === 'Accepted') {
      logger.debug('[createPlacementFromInterview] Offer already accepted, placement exists');
      return;
    }
    if (existingOffer.status === 'Draft') {
      try {
        await emailOfferLetterAndCompletePlacement(existingOffer._id, userId);
        logger.info('[createPlacementFromInterview] Completed placement workflow for application %s', application._id);
      } catch (err) {
        logger.error('[createPlacementFromInterview] Failed to complete offer from Draft:', err?.message || err);
        throw err;
      }
      return;
    }
    if (existingOffer.status === 'Sent' || existingOffer.status === 'Under Negotiation') {
      const hasPlacement = await Placement.exists({ offer: existingOffer._id });
      if (hasPlacement) {
        logger.debug('[createPlacementFromInterview] Offer already has placement, skipping');
        return;
      }
      if (!existingOffer.joiningDate) {
        logger.warn(
          '[createPlacementFromInterview] Offer %s has no joining date; cannot create placement. Update the offer in Offers & placement.',
          existingOffer._id
        );
        return;
      }
      try {
        await offerService.updateOfferById(
          existingOffer._id.toString(),
          { status: 'Accepted' },
          { id: userId, _id: userId },
          { skipAccessCheck: true }
        );
        logger.info('[createPlacementFromInterview] Accepted existing Sent offer for application %s, placement created', application._id);
      } catch (err) {
        logger.error('[createPlacementFromInterview] Failed to accept existing offer:', err?.message || err);
        throw err;
      }
      return;
    }
    logger.debug('[createPlacementFromInterview] Offer exists with status %s, skipping', existingOffer.status);
    return;
  }

  try {
    await offerService.createOffer(
      application._id.toString(),
      {
        ctcBreakdown: { base: 0, hra: 0, gross: 0, currency: 'INR' },
        joiningDate: defaultJoiningDateForInterviewOffer(),
      },
      userId
    );
    const created = await Offer.findOne({ jobApplication: application._id });
    if (created) {
      await emailOfferLetterAndCompletePlacement(created._id, userId);
    }
    logger.info('[createPlacementFromInterview] Created offer and placement for application %s', application._id);
  } catch (err) {
    logger.error('[createPlacementFromInterview] Failed to create/accept offer:', err?.message || err);
    throw err;
  }
};

/**
 * Update meeting by id (MongoDB ObjectId or meetingId string)
 * @param {string} id - MongoDB ObjectId or meetingId
 * @param {Object} updateBody
 * @param {string} [userId] - User performing the update (needed for move-to-preboarding)
 * @returns {Promise<Meeting>}
 */
const updateMeetingById = async (id, updateBody, userId) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
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

  let moveError = null;
  if (
    updateBody.interviewResult === 'selected' &&
    meeting.candidate?.id
  ) {
    const effectiveUserId = userId || meeting.createdBy?.toString?.() || meeting.createdBy;
    try {
      await createPlacementFromInterview(meeting, effectiveUserId);
    } catch (err) {
      moveError = err?.message || String(err);
      logger.warn('[createPlacementFromInterview] Failed:', moveError);
    }
  }

  const result = await getMeetingById(meeting._id.toString());
  if (moveError) result.moveToPreboardingError = moveError;
  return result;
};

/**
 * Delete meeting by id
 * @param {ObjectId} id
 * @returns {Promise<Meeting|null>}
 */
const deleteMeetingById = async (id) => {
  const meeting = await Meeting.findById(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await meeting.deleteOne();
  return meeting;
};

/**
 * Resend meeting invitations
 * @param {ObjectId} id
 * @returns {Promise<{ sent: number }>}
 */
const resendMeetingInvitations = async (id) => {
  const meeting = await Meeting.findById(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const emails = getInvitationEmails(meeting);
  const scheduled = meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleString() : 'TBD';
  let sent = 0;
  const { notifyByEmail } = await import('./notification.service.js');
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
        hostName: meeting.recruiter?.name || meeting.hosts?.[0]?.nameOrRole || '',
        interviewType: meeting.interviewType,
        jobPosition: meeting.jobPosition,
        description: meeting.description,
        publicMeetingUrl: personalUrl,
      };
      return sendMeetingInvitationEmail(to, payload)
        .then(() => {
          sent += 1;
        })
        .catch((err) => {
          logger.warn(`Failed to send meeting invitation to ${to}:`, err?.message || err);
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
      link: personalUrl,
    }).catch(() => {});
  });
  return { sent };
};

/**
 * End meeting by room name (public: host only by email)
 * @param {string} roomName - meetingId (room name)
 * @param {string} hostEmail - Email of the participant leaving (must be a host)
 * @returns {Promise<Meeting>}
 */
/**
 * Manually trigger move to preboarding for a meeting (e.g. retry for already-selected interviews).
 * Idempotent: skips if placement already exists.
 * @param {string} id - Meeting id (ObjectId or meetingId)
 * @param {string} [userId] - User performing the action
 * @returns {Promise<{ moved: boolean; message: string }>}
 */
const moveMeetingToPreboarding = async (id, userId) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  if (meeting.interviewResult !== 'selected') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Interview result must be "Selected" to move to pre-boarding');
  }
  if (!meeting.candidate?.id) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Meeting has no candidate linked');
  }
  const effectiveUserId = userId || meeting.createdBy?.toString?.() || meeting.createdBy;
  await createPlacementFromInterview(meeting, effectiveUserId);
  return { moved: true, message: 'Candidate moved to pre-boarding' };
};

/** @deprecated use createPlacementFromInterview */
const moveCandidateToPreboarding = createPlacementFromInterview;

/**
 * End meeting by room name (public: host only by email)
 * @param {string} roomName - meetingId (room name)
 * @param {string} hostEmail - Email of the participant leaving (must be a host)
 * @returns {Promise<Meeting>}
 */
const endMeetingByRoomPublic = async (roomName, hostEmail) => {
  const meeting = await Meeting.findOne({ meetingId: roomName });
  if (meeting) {
    const emailLower = (hostEmail || '').toLowerCase().trim();
    const isHost = meeting.hosts?.some((h) => (h.email || '').toLowerCase().trim() === emailLower);
    if (!isHost) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Only a host can end the meeting');
    }
    meeting.status = 'ended';
    await meeting.save();
    try {
      await deleteInterviewRoom(roomName);
    } catch (err) {
      logger.warn('[endMeetingByRoomPublic] LiveKit deleteInterviewRoom failed', { roomName, err: err?.message || err });
    }
    const doc = meeting.toJSON();
    doc.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
    return doc;
  }
  const internal = await InternalMeeting.findOne({ meetingId: roomName });
  if (!internal) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const emailLower = (hostEmail || '').toLowerCase().trim();
  const isHost = internal.hosts?.some((h) => (h.email || '').toLowerCase().trim() === emailLower);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only a host can end the meeting');
  }
  internal.status = 'ended';
  await internal.save();
  try {
    await deleteInterviewRoom(roomName);
  } catch (err) {
    logger.warn('[endMeetingByRoomPublic] LiveKit deleteInterviewRoom failed (internal)', { roomName, err: err?.message || err });
  }
  const doc = internal.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(internal.meetingId);
  return doc;
};

/**
 * Auto-end meetings that have passed their scheduled end time (scheduledAt + durationMinutes).
 * Called by the meeting scheduler.
 * @returns {Promise<number>} Number of meetings auto-ended
 */
const autoEndExpiredMeetings = async () => {
  const now = new Date();
  const meetings = await Meeting.find({
    status: 'scheduled',
    $expr: {
      $lte: [
        { $add: ['$scheduledAt', { $multiply: ['$durationMinutes', 60000] }] },
        now,
      ],
    },
  }).lean();

  let count = 0;
  for (const m of meetings) {
    try {
      await Meeting.updateOne({ _id: m._id }, { status: 'ended' });
      await deleteInterviewRoom(m.meetingId).catch((err) =>
        logger.warn(`[autoEndExpiredMeetings] LiveKit delete failed ${m.meetingId}:`, err?.message || err)
      );
      count += 1;
      logger.info(`[autoEndExpiredMeetings] Auto-ended meeting ${m.meetingId} (${m.title})`);
    } catch (err) {
      logger.warn(`[autoEndExpiredMeetings] Failed to end meeting ${m.meetingId}:`, err?.message || err);
    }
  }
  return count;
};

const meetingReminderSentIds = new Set();

/**
 * Send in-app + optional email reminders for meetings starting in ~15 minutes.
 * Called by meeting scheduler. Tracks sent IDs to avoid duplicate reminders.
 */
export const sendUpcomingMeetingReminders = async () => {
  const now = new Date();
  const windowStart = new Date(now.getTime() + 10 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 20 * 60 * 1000);
  const meetings = await Meeting.find({
    status: 'scheduled',
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
  })
    .populate('candidate', 'email')
    .populate('recruiter', 'email')
    .lean();

  const User = (await import('../models/user.model.js')).default;
  const { notify } = await import('./notification.service.js');

  for (const m of meetings) {
    const idStr = m._id.toString();
    if (meetingReminderSentIds.has(idStr)) continue;
    meetingReminderSentIds.add(idStr);
    const emails = getInvitationEmails(m);
    const title = m.title || 'Meeting';
    const message = `Your meeting "${title}" starts in 15 minutes.`;
    const remindedUserIds = new Set();
    for (const email of emails) {
      const inviteName = resolveInviteeDisplayName(m, email);
      const publicUrl = getPublicMeetingUrl(m.meetingId, { name: inviteName, email });
      const user = await User.findOne({ email: new RegExp(`^${String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
        .select('_id')
        .lean();
      const uid = user?._id ? String(user._id) : '';
      if (user && uid && !remindedUserIds.has(uid)) {
        remindedUserIds.add(uid);
        notify(user._id, {
          type: 'meeting_reminder',
          title: 'Meeting reminder',
          message,
          link: publicUrl,
          email: {
            subject: `Reminder: ${title} starts soon`,
            text: `${message}\n\n${publicUrl}`,
          },
        }).catch(() => {});
      }
    }
  }

  const toDelete = [];
  for (const idStr of meetingReminderSentIds) {
    const meeting = await Meeting.findById(idStr).select('scheduledAt').lean();
    if (!meeting || meeting.scheduledAt < now) toDelete.push(idStr);
  }
  toDelete.forEach((id) => meetingReminderSentIds.delete(id));
};

export {
  createMeeting,
  queryMeetings,
  getMeetingById,
  getMeetingByMeetingId,
  updateMeetingById,
  deleteMeetingById,
  resendMeetingInvitations,
  moveMeetingToPreboarding,
  createPlacementFromInterview,
  moveCandidateToPreboarding,
  getPublicMeetingUrl,
  endMeetingByRoomPublic,
  autoEndExpiredMeetings,
};
