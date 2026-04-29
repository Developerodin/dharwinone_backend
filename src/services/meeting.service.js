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

/** Same pipeline rows createPlacementFromInterview operates on (retry includes Offered/Hired). */
const PIPELINE_STATUSES = ['Applied', 'Screening', 'Interview', 'Offered', 'Hired'];

/**
 * Resolve job application for an interview's candidate + jobPosition (shared forward / rollback).
 * @param {object} meeting - Meeting doc
 * @param {{ createIfMissing?: boolean }} [options]
 * @returns {Promise<{ candidateObjId: import('mongoose').Types.ObjectId|null, jobId: string|null, application: import('mongoose').Document|null }>}
 */
async function resolveJobApplicationForInterviewMeeting(meeting, options = {}) {
  const { createIfMissing = true } = options;
  const candidateId = meeting.candidate?.id;
  if (!candidateId || !mongoose.Types.ObjectId.isValid(candidateId)) {
    return { candidateObjId: null, jobId: null, application: null };
  }

  const candidateObjId = new mongoose.Types.ObjectId(candidateId);

  let jobId = null;
  const jobPositionVal = (meeting.jobPosition || '').trim();

  if (/^[0-9a-fA-F]{24}$/.test(jobPositionVal)) {
    jobId = jobPositionVal;
  } else if (jobPositionVal) {
    const job = await Job.findOne({
      title: { $regex: new RegExp(`^${jobPositionVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    })
      .select('_id')
      .lean();
    jobId = job?._id?.toString() || null;
  }

  let application = null;

  if (jobId) {
    application = await JobApplication.findOne({
      candidate: candidateObjId,
      job: new mongoose.Types.ObjectId(jobId),
      status: { $in: PIPELINE_STATUSES },
    });
  }

  if (!application) {
    application = await JobApplication.findOne({
      candidate: candidateObjId,
      status: { $in: PIPELINE_STATUSES },
    }).sort({ updatedAt: -1 });
    if (application?.job) {
      jobId = application.job._id?.toString?.() ?? String(application.job);
    }
  }

  if (!application && jobId && createIfMissing) {
    try {
      const existing = await JobApplication.findOne({
        candidate: candidateObjId,
        job: new mongoose.Types.ObjectId(jobId),
      });
      if (existing && PIPELINE_STATUSES.includes(existing.status)) {
        application = existing;
      } else if (!existing) {
        application = await JobApplication.create({
          job: new mongoose.Types.ObjectId(jobId),
          candidate: candidateObjId,
          status: 'Interview',
        });
        logger.info(
          '[resolveJobApplicationForInterviewMeeting] Created JobApplication for candidate %s + job %s',
          candidateId,
          jobId
        );
      }
    } catch (err) {
      logger.warn('[resolveJobApplicationForInterviewMeeting] Could not create JobApplication:', err?.message || err);
      throw new ApiError(httpStatus.BAD_REQUEST, `Could not link to a job application: ${err?.message || String(err)}`);
    }
  }

  return { candidateObjId, jobId, application };
}

/**
 * When rollback needs an application row that left PIPELINE_STATUSES (e.g. Rejected), widen lookup.
 */
async function resolveJobApplicationForInterviewRollback(meeting) {
  const resolved = await resolveJobApplicationForInterviewMeeting(meeting, {
    createIfMissing: false,
  });
  const { candidateObjId, jobId } = resolved;
  let { application } = resolved;
  if (application || !candidateObjId) {
    return { candidateObjId, jobId, application };
  }
  if (jobId) {
    application = await JobApplication.findOne({
      candidate: candidateObjId,
      job: new mongoose.Types.ObjectId(jobId),
    });
  }
  if (!application) {
    application = await JobApplication.findOne({ candidate: candidateObjId }).sort({ updatedAt: -1 });
  }
  return { candidateObjId, jobId, application };
}

/**
 * Undo Offers/placement pipeline created when result was Selected: delete Pending (etc.) placement + offer,
 * set JobApplication back to Interview. Skips if placement already Joined (onboarding started).
 */
async function rollbackInterviewSelectionPipeline(meeting) {
  let syncCandidateId = null;
  try {
    const { candidateObjId, application } = await resolveJobApplicationForInterviewRollback(meeting);
    if (!candidateObjId || !application) {
      logger.info('[rollbackInterviewSelectionPipeline] No application — nothing to roll back');
      return;
    }

    const offer = await Offer.findOne({ jobApplication: application._id });
    if (!offer) {
      const st = application.status;
      if (st === 'Offered' || st === 'Hired') {
        await JobApplication.updateOne({ _id: application._id }, { $set: { status: 'Interview' } });
        syncCandidateId = candidateObjId;
      }
      logger.info('[rollbackInterviewSelectionPipeline] No offer doc — normalized application status only');
      if (syncCandidateId) await syncReferralPipelineStatusForCandidate(syncCandidateId);
      return;
    }

    const placement = await Placement.findOne({ offer: offer._id }).lean();

    if (placement?.status === 'Joined') {
      logger.warn(
        '[rollbackInterviewSelectionPipeline] Placement already Joined — skipping destructive rollback (meeting=%s)',
        meeting._id
      );
      return;
    }

    if (placement) {
      await Placement.deleteOne({ _id: placement._id });
    }

    await Offer.deleteOne({ _id: offer._id });

    await JobApplication.updateOne({ _id: application._id }, { $set: { status: 'Interview' } });

    syncCandidateId = candidateObjId;

    logger.info(
      '[rollbackInterviewSelectionPipeline] Rolled back offer/placement for application %s (meeting=%s)',
      application._id,
      meeting._id
    );
  } catch (err) {
    logger.error('[rollbackInterviewSelectionPipeline] Failed:', err?.message || err);
    throw err;
  }

  if (syncCandidateId) {
    await syncReferralPipelineStatusForCandidate(syncCandidateId);
  }
}

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
 * Interview selection creates offers in Draft. Ensure a default joining date so the Offer Letter Generator
 * can validate; do not advance status — recruiters send and accept from Offers & Placement.
 * @param {import('mongoose').Types.ObjectId|string} offerId
 * @param {string} userId
 */
const ensureInterviewOfferLetterDefaults = async (offerId, userId) => {
  const actor = { id: userId, _id: userId };
  const id = offerId.toString();
  const offer = await offerService.getOfferById(id, null);
  if (!offer) {
    logger.warn('[ensureInterviewOfferLetterDefaults] Offer not found %s', id);
    return;
  }
  if (offer.status === 'Accepted' || offer.status === 'Rejected') {
    return;
  }

  if (!offer.joiningDate) {
    await offerService.updateOfferById(
      id,
      { joiningDate: defaultJoiningDateForInterviewOffer() },
      actor,
      { skipAccessCheck: true }
    );
  }
};

/**
 * [ADR] createPlacementFromInterview: ensures a Draft offer (+ default joining date when missing) for this interview’s
 * job application. Placement is created when the offer is Accepted from Offers & Placement — not during this call.
 * @deprecated use createPlacementFromInterview name; `moveCandidateToPreboarding` is a backward-compatible alias.
 * Runs when interview result is "selected".
 * @param {Object} meeting - Meeting document (after save)
 * @param {string} userId - User performing the action
 */
const createPlacementFromInterview = async (meeting, userId) => {
  const { candidateObjId, application } = await resolveJobApplicationForInterviewMeeting(meeting, {
    createIfMissing: true,
  });

  if (!candidateObjId) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Cannot move to Offers & placement: this interview has no valid candidate linked. Edit the interview and choose a candidate.'
    );
  }

  if (!application) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Cannot move to Offers & placement: no job application found for this candidate. Ensure they have an application in progress (Applied, Screening, Interview, Offered, or Hired).'
    );
  }

  const existingOffer = await Offer.findOne({ jobApplication: application._id });
  if (existingOffer) {
    if (existingOffer.status === 'Accepted') {
      logger.debug('[createPlacementFromInterview] Offer already accepted, placement exists');
      return;
    }
    if (existingOffer.status === 'Draft') {
      try {
        await ensureInterviewOfferLetterDefaults(existingOffer._id, userId);
        logger.info(
          '[createPlacementFromInterview] Draft offer ensured (joining date); awaiting acceptance in Offers & placement — application %s',
          application._id
        );
      } catch (err) {
        logger.error('[createPlacementFromInterview] Failed to ensure draft offer defaults:', err?.message || err);
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
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'An offer exists but has no joining date. Open Offers & placement, set joining date, then accept the offer or use Move to Pre-boarding again.'
        );
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
    // BUG-10 FIX: specific, actionable message when offer was previously rejected.
    if (existingOffer.status === 'Rejected') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'The offer for this application was previously rejected. To re-hire this candidate, delete the rejected offer in Offers & Placement first, then retry Move to Pre-boarding.'
      );
    }
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot auto-move to Offers & placement: an offer already exists with status "${existingOffer.status}". Open Offers & placement to continue.`
    );
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
      await ensureInterviewOfferLetterDefaults(created._id, userId);
    }
    logger.info('[createPlacementFromInterview] Created draft offer for application %s (complete in Offers & placement)', application._id);
  } catch (err) {
    // BUG-8 FIX: race condition — two concurrent requests both passed the existingOffer check.
    // The second call gets "An offer already exists"; treat it as an idempotent success.
    if (
      (err?.statusCode === 400 || err?.status === 400) &&
      /already exists/i.test(err?.message || '')
    ) {
      logger.info('[createPlacementFromInterview] Concurrent offer creation detected for application %s — treating as success', application._id);
      const created = await Offer.findOne({ jobApplication: application._id });
      if (created && created.status !== 'Accepted' && created.status !== 'Rejected') {
        await ensureInterviewOfferLetterDefaults(created._id, userId);
      }
      return;
    }
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
  const previousInterviewResult = meeting.interviewResult;
  const safeBody = { ...updateBody };
  const dur = Number(safeBody.durationMinutes);
  if (Number.isInteger(dur) && dur >= 1 && dur <= 480) {
    safeBody.durationMinutes = dur;
  } else if ('durationMinutes' in safeBody) {
    delete safeBody.durationMinutes;
  }
  Object.assign(meeting, safeBody);
  await meeting.save();

  const newInterviewResult = meeting.interviewResult;

  if (
    previousInterviewResult === 'selected' &&
    (newInterviewResult === 'pending' || newInterviewResult === 'rejected')
  ) {
    try {
      await rollbackInterviewSelectionPipeline(meeting);
    } catch (err) {
      logger.error('[updateMeetingById] rollbackInterviewSelectionPipeline failed:', err?.message || err);
    }
  }

  let moveError = null;
  if (
    updateBody.interviewResult === 'selected' &&
    meeting.candidate?.id
  ) {
    // BUG-6 FIX: guard null effectiveUserId — createOffer requires createdBy.
    const effectiveUserId = userId || meeting.createdBy?.toString?.() || meeting.createdBy;
    if (!effectiveUserId) {
      const msg = 'Cannot create offer: no user identity available for this meeting. Please retry while logged in.';
      logger.warn('[updateMeetingById] %s (meetingId=%s)', msg, meeting._id);
      const result2 = await getMeetingById(meeting._id.toString());
      result2.moveToPreboardingError = msg;
      return result2;
    }
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
