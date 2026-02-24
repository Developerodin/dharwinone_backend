import mongoose from 'mongoose';
import Meeting from '../models/meeting.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Job from '../models/job.model.js';
import Offer from '../models/offer.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { sendMeetingInvitationEmail } from './email.service.js';
import logger from '../config/logger.js';
import * as offerService from './offer.service.js';

/**
 * Build public meeting URL for a meetingId
 * @param {string} meetingId
 * @returns {string}
 */
const getPublicMeetingUrl = (meetingId) => {
  const base = (config.frontendBaseUrl || '').replace(/\/$/, '');
  return `${base}/join/room?room=${encodeURIComponent(meetingId)}`;
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
  const meetingId = await Meeting.generateMeetingId();
  const durationMinutes = Number(body.durationMinutes) || 60;
  const meeting = await Meeting.create({
    ...body,
    durationMinutes,
    meetingId,
    roomName: meetingId, // same as meetingId for LiveKit; satisfies legacy index roomName_1
    createdBy: userId,
  });

  const publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
  const meetingObj = meeting.toJSON();
  meetingObj.publicMeetingUrl = publicMeetingUrl;

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
      JobApplication.updateOne(
        { candidate: new mongoose.Types.ObjectId(candId), job: jobObjId, status: { $in: ['Applied', 'Screening'] } },
        { status: 'Interview' }
      ).catch((err) => logger.warn('Failed to update JobApplication to Interview:', err?.message || err));
    }
  }

  // Send invitation emails (fire-and-forget; log errors)
  const emails = getInvitationEmails(meeting);
  const payload = {
    title: meeting.title,
    scheduledAt: meeting.scheduledAt,
    durationMinutes: meeting.durationMinutes,
    publicMeetingUrl,
  };
  emails.forEach((to) => {
    sendMeetingInvitationEmail(to, payload).catch((err) => {
      logger.warn(`Failed to send meeting invitation to ${to}:`, err?.message || err);
    });
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
 * Get meeting by meetingId (for public URL lookup)
 * @param {string} meetingId
 * @returns {Promise<Meeting|null>}
 */
const getMeetingByMeetingId = async (meetingId) => {
  const meeting = await Meeting.findOne({ meetingId }).populate('createdBy');
  if (!meeting) return null;
  const doc = meeting.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
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

/**
 * Move candidate to preboarding when interview result is "selected".
 * Creates an offer, sets it to Accepted (which creates Placement with status Pending).
 * @param {Object} meeting - Meeting document (after save)
 * @param {string} userId - User performing the action
 */
const moveCandidateToPreboarding = async (meeting, userId) => {
  const candidateId = meeting.candidate?.id;
  if (!candidateId || !mongoose.Types.ObjectId.isValid(candidateId)) {
    logger.warn('[moveCandidateToPreboarding] No valid candidate id on meeting %s', meeting._id);
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
        logger.info('[moveCandidateToPreboarding] Created JobApplication for candidate %s + job %s', candidateId, jobId);
      }
    } catch (err) {
      logger.warn('[moveCandidateToPreboarding] Could not create JobApplication:', err?.message || err);
      return;
    }
  }

  if (!application) {
    logger.warn('[moveCandidateToPreboarding] No job application for meeting %s (candidate %s)', meeting._id, candidateId);
    return;
  }

  const existingOffer = await Offer.findOne({ jobApplication: application._id });
  if (existingOffer) {
    if (existingOffer.status === 'Accepted') {
      logger.debug('[moveCandidateToPreboarding] Offer already accepted, placement exists');
      return;
    }
    if (existingOffer.status === 'Draft') {
      await offerService.updateOfferById(
        existingOffer._id.toString(),
        { status: 'Accepted' },
        { id: userId, _id: userId },
        { skipAccessCheck: true }
      );
      logger.info('[moveCandidateToPreboarding] Updated Draft offer to Accepted for application %s', application._id);
      return;
    }
    logger.debug('[moveCandidateToPreboarding] Offer exists with status %s, skipping', existingOffer.status);
    return;
  }

  try {
    const offer = await offerService.createOffer(
      application._id.toString(),
      { ctcBreakdown: { base: 0, hra: 0, gross: 0, currency: 'INR' } },
      userId
    );
    await offerService.updateOfferById(
      offer._id.toString(),
      { status: 'Accepted' },
      { id: userId, _id: userId },
      { skipAccessCheck: true }
    );
    logger.info('[moveCandidateToPreboarding] Created and accepted offer for application %s, placement created', application._id);
  } catch (err) {
    logger.error('[moveCandidateToPreboarding] Failed to create/accept offer:', err?.message || err);
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
      await moveCandidateToPreboarding(meeting, effectiveUserId);
    } catch (err) {
      moveError = err?.message || String(err);
      logger.warn('[moveCandidateToPreboarding] Failed:', moveError);
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
  const publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
  const emails = getInvitationEmails(meeting);
  const payload = {
    title: meeting.title,
    scheduledAt: meeting.scheduledAt,
    durationMinutes: meeting.durationMinutes,
    publicMeetingUrl,
  };
  let sent = 0;
  await Promise.all(
    emails.map((to) =>
      sendMeetingInvitationEmail(to, payload)
        .then(() => {
          sent += 1;
        })
        .catch((err) => {
          logger.warn(`Failed to send meeting invitation to ${to}:`, err?.message || err);
        })
    )
  );
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
  await moveCandidateToPreboarding(meeting, effectiveUserId);
  return { moved: true, message: 'Candidate moved to pre-boarding' };
};

/**
 * End meeting by room name (public: host only by email)
 * @param {string} roomName - meetingId (room name)
 * @param {string} hostEmail - Email of the participant leaving (must be a host)
 * @returns {Promise<Meeting>}
 */
const endMeetingByRoomPublic = async (roomName, hostEmail) => {
  const meeting = await Meeting.findOne({ meetingId: roomName });
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
  const doc = meeting.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
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
      count += 1;
      logger.info(`[autoEndExpiredMeetings] Auto-ended meeting ${m.meetingId} (${m.title})`);
    } catch (err) {
      logger.warn(`[autoEndExpiredMeetings] Failed to end meeting ${m.meetingId}:`, err?.message || err);
    }
  }
  return count;
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
  getPublicMeetingUrl,
  endMeetingByRoomPublic,
  autoEndExpiredMeetings,
};
