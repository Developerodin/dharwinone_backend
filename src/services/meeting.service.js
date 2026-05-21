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
import { logActivity as logRecruiterActivity } from './recruiterActivity.service.js';
import { dispatchReminder, isRetryableCategory } from './reminderDispatcher.js';

const REMINDER_MAX_ATTEMPTS = 3;
const reminderWindowStartMin = () => Number(process.env.REMINDER_WINDOW_START_MIN) || 15;
const reminderWindowEndMin = () => Number(process.env.REMINDER_WINDOW_END_MIN) || 20;
const reminderLeaseTtlMs = () => Number(process.env.REMINDER_LEASE_TTL_MS) || 600000;

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
  (meeting.agents || []).forEach((a) => {
    if (a?.email && String(a.email).trim()) set.add(String(a.email).trim().toLowerCase());
  });
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

  const rawCandId = meeting.candidate?.id;
  const candidateIdForLog =
    rawCandId && mongoose.Types.ObjectId.isValid(rawCandId) && String(new mongoose.Types.ObjectId(rawCandId)) === String(rawCandId)
      ? rawCandId
      : undefined;
  logRecruiterActivity(userId, 'interview_scheduled', {
    candidateId: candidateIdForLog,
    meetingId: meeting._id,
    description: `Scheduled interview: ${meeting.title || meeting.meetingId}`,
    metadata: {
      interviewType: meeting.interviewType,
      jobPosition: meeting.jobPosition,
      scheduledAt: meeting.scheduledAt,
      durationMinutes: meeting.durationMinutes,
      ...(candidateIdForLog ? {} : { candidateRawId: rawCandId || null }),
    },
  }).catch((err) => logger.warn('logRecruiterActivity interview_scheduled:', err?.message || err));

  // Update JobApplication to Interview when scheduling (candidate + job present)
  const candId = meeting.candidate?.id;
  const jobPos = (meeting.jobPosition || '').trim();
  if (candId && mongoose.Types.ObjectId.isValid(candId) && jobPos) {
    let jobObjId = null;
    if (/^[0-9a-fA-F]{24}$/.test(jobPos)) {
      // B6 fix: confirm the job still exists before referencing it. A bare ObjectId cast
      // could leave the Meeting / JobApplication referencing a deleted job (silent inconsistency).
      const j = await Job.findById(jobPos).select('_id').lean();
      jobObjId = j?._id || null;
      if (!jobObjId) {
        logger.warn(`createMeeting: jobPosition ${jobPos} resolved to no existing Job; skipping JobApplication transition`);
      }
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
        ctcBreakdown: { base: 0, hra: 0, gross: 0, currency: 'USD' },
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
  const previousStatus = meeting.status;
  const safeBody = { ...updateBody };
  const dur = Number(safeBody.durationMinutes);
  if (Number.isInteger(dur) && dur >= 1 && dur <= 480) {
    safeBody.durationMinutes = dur;
  } else if ('durationMinutes' in safeBody) {
    delete safeBody.durationMinutes;
  }
  Object.assign(meeting, safeBody);
  await meeting.save();

  // If admin flips status -> 'ended' via PATCH, mirror endMeetingByRoomPublic:
  // stop active egress + wait for finalize before deleting LiveKit room. Without
  // this, the recorder participant kept running and S3 upload never finalized.
  if (previousStatus !== 'ended' && meeting.status === 'ended' && meeting.meetingId) {
    try {
      await deleteInterviewRoom(meeting.meetingId);
    } catch (err) {
      logger.warn('[updateMeetingById] LiveKit deleteInterviewRoom failed', {
        meetingId: meeting.meetingId,
        err: err?.message || err,
      });
    }
  }

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
  // Stop egress + wait for finalize BEFORE removing the meeting doc, otherwise
  // a live recording is orphaned in EGRESS_ACTIVE with no DB row to reconcile.
  if (meeting.meetingId) {
    try {
      await deleteInterviewRoom(meeting.meetingId);
    } catch (err) {
      logger.warn('[deleteMeetingById] LiveKit deleteInterviewRoom failed', {
        meetingId: meeting.meetingId,
        err: err?.message || err,
      });
    }
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
      await Meeting.updateOne(
        { _id: m._id },
        {
          $set: {
            status: 'ended',
            ...(m.interviewCompletedAt ? {} : { interviewCompletedAt: now }),
          },
        }
      );
      await deleteInterviewRoom(m.meetingId).catch((err) =>
        logger.warn(`[autoEndExpiredMeetings] LiveKit delete failed ${m.meetingId}:`, err?.message || err)
      );
      count += 1;
      logger.info(`[autoEndExpiredMeetings] Auto-ended meeting ${m.meetingId} (${m.title})`);
    } catch (err) {
      logger.warn(`[autoEndExpiredMeetings] Failed to end meeting ${m.meetingId}:`, err?.message || err);
    }
  }

  const expiredInternal = await InternalMeeting.find({
    status: 'scheduled',
    $expr: {
      $lte: [
        { $add: ['$scheduledAt', { $multiply: ['$durationMinutes', 60000] }] },
        now,
      ],
    },
  }).lean();

  for (const m of expiredInternal) {
    try {
      await InternalMeeting.updateOne({ _id: m._id }, { status: 'ended' });
      await deleteInterviewRoom(m.meetingId).catch((err) =>
        logger.warn(`[autoEndExpiredMeetings] LiveKit delete failed ${m.meetingId}:`, err?.message || err)
      );
      count += 1;
      logger.info(`[autoEndExpiredMeetings] Auto-ended internal meeting ${m.meetingId} (${m.title})`);
    } catch (err) {
      logger.warn(`[autoEndExpiredMeetings] Failed to end internal meeting ${m.meetingId}:`, err?.message || err);
    }
  }

  return count;
};

/**
 * T-15 reminder pass. For every scheduled interview starting within the
 * configured window, lease-claim it, deliver email + in-app reminders through
 * the dispatcher, and record success / retry / failure.
 * @returns {Promise<{sent:number, retried:number, failed:number, staleRecovered:number}>}
 */
export const sendUpcomingMeetingReminders = async () => {
  const now = new Date();
  const windowStart = new Date(now.getTime() + reminderWindowStartMin() * 60000);
  const windowEnd = new Date(now.getTime() + reminderWindowEndMin() * 60000);
  const leaseFloor = new Date(now.getTime() - reminderLeaseTtlMs());

  const meetings = await Meeting.find({
    status: 'scheduled',
    reminderSentAt: null,
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
    'reminderRetry.attempts': { $lt: REMINDER_MAX_ATTEMPTS },
    $or: [{ 'reminderRetry.claimedAt': null }, { 'reminderRetry.claimedAt': { $lt: leaseFloor } }],
  })
    .limit(200)
    .lean();

  const stats = { sent: 0, retried: 0, failed: 0, staleRecovered: 0 };
  if (!meetings.length) return stats;

  const { notify } = await import('./notification.service.js');
  const { sendMeetingReminderEmail } = await import('./email.service.js');
  const User = (await import('../models/user.model.js')).default;

  for (const m of meetings) {
    const claim = await Meeting.findOneAndUpdate(
      {
        _id: m._id,
        reminderSentAt: null,
        'reminderRetry.attempts': { $lt: REMINDER_MAX_ATTEMPTS },
        $or: [{ 'reminderRetry.claimedAt': null }, { 'reminderRetry.claimedAt': { $lt: leaseFloor } }],
      },
      { $set: { 'reminderRetry.claimedAt': now }, $inc: { 'reminderRetry.attempts': 1 } },
      { new: true }
    ).lean();
    if (!claim) continue;
    if (m.reminderRetry?.claimedAt) stats.staleRecovered += 1;

    const title = m.title || 'Interview';
    const message = `Your interview "${title}" starts soon.`;
    const emails = getInvitationEmails(m);
    const recipients = emails.map((email) => ({ email }));

    const result = await dispatchReminder({
      kind: 'interviewT15',
      recipients,
      deliver: async ({ email }) => {
        const inviteName = resolveInviteeDisplayName(m, email);
        const link = getPublicMeetingUrl(m.meetingId, { name: inviteName, email });
        const user = await User.findOne({
          email: new RegExp(`^${String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        })
          .select('_id')
          .lean();
        if (user?._id) {
          try {
            await notify(user._id, {
              type: 'meeting_reminder',
              title: 'Interview reminder',
              message,
              link,
            });
          } catch (err) {
            logger.warn(`T-15 in-app notify failed for ${email}: ${err?.message || err}`);
          }
        }
        await sendMeetingReminderEmail(email, {
          title,
          scheduledAt: m.scheduledAt,
          timezone: m.timezone || 'UTC',
          publicMeetingUrl: link,
          inviteeName: inviteName,
        });
      },
    });

    if (result.ok) {
      await Meeting.updateOne(
        { _id: m._id },
        { $set: { reminderSentAt: now, 'reminderRetry.claimedAt': null } }
      );
      stats.sent += 1;
    } else {
      const retryable = isRetryableCategory(result.errorCategory);
      const exhausted = (claim.reminderRetry?.attempts || 0) >= REMINDER_MAX_ATTEMPTS;
      const update = {
        'reminderRetry.claimedAt': null,
        'reminderRetry.lastError': result.error,
        'reminderRetry.lastErrorAt': now,
        'reminderRetry.lastErrorCategory': result.errorCategory,
      };
      if (!retryable || exhausted) {
        update['reminderRetry.failedAt'] = now;
        stats.failed += 1;
      } else {
        stats.retried += 1;
      }
      await Meeting.updateOne({ _id: m._id }, { $set: update });
    }
  }

  return stats;
};

const CONCLUSION_MAX_ATTEMPTS = 3;
const conclusionDelayMin = () => Number(process.env.CONCLUSION_DELAY_MIN) || 15;

/**
 * Conclusion reminder pass. For every ended interview whose result is still
 * pending and whose anchor plus the delay has passed, notify the recruiter side.
 * @returns {Promise<{sent:number, retried:number, failed:number, staleRecovered:number}>}
 */
export const sendInterviewConclusionNotifications = async () => {
  const now = new Date();
  const leaseFloor = new Date(now.getTime() - reminderLeaseTtlMs());
  const delayMs = conclusionDelayMin() * 60000;

  const meetings = await Meeting.find({
    status: 'ended',
    interviewResult: 'pending',
    conclusionNotifiedAt: null,
    'conclusionRetry.attempts': { $lt: CONCLUSION_MAX_ATTEMPTS },
    $or: [{ 'conclusionRetry.claimedAt': null }, { 'conclusionRetry.claimedAt': { $lt: leaseFloor } }],
  })
    .limit(200)
    .lean();

  const stats = { sent: 0, retried: 0, failed: 0, staleRecovered: 0 };
  if (!meetings.length) return stats;

  const { notify } = await import('./notification.service.js');
  const { sendInterviewConclusionEmail } = await import('./email.service.js');

  for (const m of meetings) {
    const anchor = m.interviewCompletedAt
      ? new Date(m.interviewCompletedAt)
      : new Date(new Date(m.scheduledAt).getTime() + (m.durationMinutes || 60) * 60000);
    if (anchor.getTime() + delayMs > now.getTime()) continue;

    const claim = await Meeting.findOneAndUpdate(
      {
        _id: m._id,
        conclusionNotifiedAt: null,
        'conclusionRetry.attempts': { $lt: CONCLUSION_MAX_ATTEMPTS },
        $or: [{ 'conclusionRetry.claimedAt': null }, { 'conclusionRetry.claimedAt': { $lt: leaseFloor } }],
      },
      { $set: { 'conclusionRetry.claimedAt': now }, $inc: { 'conclusionRetry.attempts': 1 } },
      { new: true }
    ).lean();
    if (!claim) continue;
    if (m.conclusionRetry?.claimedAt) stats.staleRecovered += 1;

    const title = m.title || 'Interview';
    const link = getPublicMeetingUrl(m.meetingId);
    const message = `The interview "${title}" has ended — please record the result.`;

    const emailRecipients = [];
    const inAppUserIds = new Set();
    if (m.recruiter?.email) emailRecipients.push(m.recruiter.email.trim().toLowerCase());
    if (m.recruiter?.id) inAppUserIds.add(String(m.recruiter.id));
    for (const a of m.agents || []) {
      if (a?.email) emailRecipients.push(String(a.email).trim().toLowerCase());
      if (a?.id) inAppUserIds.add(String(a.id));
    }
    if (m.createdBy) inAppUserIds.add(String(m.createdBy));

    const recipients = [
      ...[...new Set(emailRecipients)].map((email) => ({ kind: 'email', email })),
      ...[...inAppUserIds].map((userId) => ({ kind: 'inApp', userId })),
    ];

    const result = await dispatchReminder({
      kind: 'conclusion',
      recipients,
      deliver: async (r) => {
        if (r.kind === 'email') {
          await sendInterviewConclusionEmail(r.email, {
            title,
            scheduledAt: m.scheduledAt,
            timezone: m.timezone,
            candidateName: m.candidate?.name,
            link,
          });
        } else {
          await notify(r.userId, {
            type: 'meeting',
            title: 'Interview ended — record result',
            message,
            link,
          });
        }
      },
    });

    if (result.ok) {
      await Meeting.updateOne(
        { _id: m._id },
        { $set: { conclusionNotifiedAt: now, 'conclusionRetry.claimedAt': null } }
      );
      stats.sent += 1;
    } else {
      const retryable = isRetryableCategory(result.errorCategory);
      const exhausted = (claim.conclusionRetry?.attempts || 0) >= CONCLUSION_MAX_ATTEMPTS;
      const update = {
        'conclusionRetry.claimedAt': null,
        'conclusionRetry.lastError': result.error,
        'conclusionRetry.lastErrorAt': now,
        'conclusionRetry.lastErrorCategory': result.errorCategory,
      };
      if (!retryable || exhausted) {
        update['conclusionRetry.failedAt'] = now;
        stats.failed += 1;
      } else {
        stats.retried += 1;
      }
      await Meeting.updateOne({ _id: m._id }, { $set: update });
    }
  }

  return stats;
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
  getInvitationEmails,
};
