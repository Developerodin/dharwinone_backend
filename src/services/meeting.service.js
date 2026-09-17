import mongoose from 'mongoose';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Job from '../models/job.model.js';
import Offer from '../models/offer.model.js';
import Placement from '../models/placement.model.js';
import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import EmployeeTransfer from '../models/employeeTransfer.model.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { setEmployeeDepartment } from './employeeDepartment.helper.js';
import { resolvePositionIdFromDesignationTitle } from './positionResolve.helper.js';
import { isExistingEmployee, isResignedEmployee } from '../utils/employeeStatus.js';
import { createActivityLog } from './activityLog.service.js';
import { writeAtsAudit } from './atsAudit.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { sendMeetingInvitationEmail, sendMeetingCancellationEmail, buildMeetingIcs, buildMeetingCancelIcs } from './email.service.js';
import logger from '../config/logger.js';
import * as offerService from './offer.service.js';
import { assertJobVacancyCapacity, queueJobOwnerVacancyFilledNotify } from './job.service.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { getPublicMeetingUrl, getInAppMeetingLink } from '../utils/meetingPublicUrl.js';
import { getMeetingByMeetingId } from './meetingLookup.service.js';
import { meetingScope } from './visibilityScope.service.js';
import config from '../config/config.js';
import Recording, { RECORDING_TERMINAL } from '../models/recording.model.js';
import { countHumanParticipants, decideAutoEnd, deleteInterviewRoom } from './livekit.service.js';
import { syncReferralPipelineStatusForCandidate } from './referralLeads.service.js';
import { logActivity as logRecruiterActivity } from './recruiterActivity.service.js';
import { dispatchReminder, isRetryableCategory } from './reminderDispatcher.js';
import {
  isAllowedTransition,
  getInterviewSchedulingBlockReason,
} from '../constants/atsPipeline.js';
import {
  deriveSchedulingLinkage,
  assertInterviewLanguage,
  allocateRoundIndex,
  resolveInterviewApplication,
  normalizeLinkageStatus,
  linkageRevisionQuery,
} from './interviewLinkage.service.js';
import { hasAllApiPermissions } from '../utils/permissionCheck.js';
import * as jobApplicationService from './jobApplication.service.js';
import { INTERVIEW_ROUND_TYPES } from '../constants/interviewLinkage.js';
import { resolveRubricForRound } from './rubricTemplate.service.js';

const REMINDER_MAX_ATTEMPTS = 3;
/** Minutes before the start that an interview reminder becomes due. */
export const reminderLeadMin = () => Number(process.env.INTERVIEW_REMINDER_LEAD_MIN) || 10;

/**
 * The moment an interview's reminder becomes due, or null when there is none to send.
 *
 * Null for an interview booked inside its own lead time: the invitation going out right now
 * is the notice, and materialising an already-past reminder is what made one arrive seconds
 * after booking.
 *
 * @param {Date|string} scheduledAt
 * @param {Date} [now]
 * @returns {Date|null}
 */
export const computeRemindAt = (scheduledAt, now = new Date()) => {
  if (!scheduledAt) return null;
  const start = new Date(scheduledAt).getTime();
  if (!Number.isFinite(start)) return null;
  const due = new Date(start - reminderLeadMin() * 60000);
  return due.getTime() > now.getTime() ? due : null;
};
const reminderLeaseTtlMs = () => Number(process.env.REMINDER_LEASE_TTL_MS) || 600000;

/** Stable client code (ApiError errorCode / linkageWarning) for interviews without a resolvable application. */
const INTERVIEW_NOT_LINKED = 'interview_not_linked';

const escapeRegexForJobTitle = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const resolveJobObjectIdFromPosition = async (jobPos) => {
  const trimmed = (jobPos || '').trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
    const j = await Job.findById(trimmed).select('_id').lean();
    return j?._id || null;
  }
  const j = await Job.findOne({
    title: { $regex: new RegExp(`^${escapeRegexForJobTitle(trimmed)}$`, 'i') },
  })
    .select('_id')
    .lean();
  return j?._id || null;
};

/** Defense-in-depth: block scheduling when the candidate's application for this job is Rejected. */
const assertInterviewSchedulingAllowed = async (candidateId, jobPosition) => {
  const candId = candidateId;
  const jobPos = (jobPosition || '').trim();
  if (!candId || !mongoose.Types.ObjectId.isValid(candId) || !jobPos) return;

  const jobObjId = await resolveJobObjectIdFromPosition(jobPos);
  if (!jobObjId) return;

  const application = await JobApplication.findOne({
    candidate: new mongoose.Types.ObjectId(candId),
    job: jobObjId,
  })
    .select('status')
    .lean();

  if (!application) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'No job application found for this candidate and position.'
    );
  }

  const blockReason = getInterviewSchedulingBlockReason(application.status);
  if (blockReason) {
    throw new ApiError(httpStatus.BAD_REQUEST, blockReason);
  }
};

/**
 * Resolve the job application for an interview (plan §8.6 strict resolver; any application status).
 * @param {object} meeting - Meeting doc
 * @returns {Promise<{ candidateObjId: import('mongoose').Types.ObjectId|null, jobId: string|null, application: import('mongoose').Document|null }>}
 */
async function resolveJobApplicationForInterviewMeeting(meeting) {
  const { candidateObjId, jobId, application } = await resolveInterviewApplication(meeting);
  return { candidateObjId, jobId, application };
}

/**
 * Rollback/rejection side effects use the same strict resolver. There is deliberately no "latest application
 * for this candidate" fallback: for an unlinked interview it picks another job's application and resets or
 * deletes that job's offer. Unlinked → the caller skips the side effect and reports INTERVIEW_NOT_LINKED.
 */
async function resolveJobApplicationForInterviewRollback(meeting) {
  return resolveJobApplicationForInterviewMeeting(meeting);
}

const skipUnlinkedSideEffect = (fnName, meeting, candidateObjId) => {
  if (!candidateObjId) return null;
  logger.warn('[%s] Interview %s is not linked to an application — application side effect skipped', fnName, meeting._id);
  return INTERVIEW_NOT_LINKED;
};

/**
 * Undo the application-stage effect of a round that was marked Selected: set JobApplication back to
 * Interview when nothing downstream exists yet.
 *
 * Deliberately non-destructive since Stage 1 decoupling. An Offer can now only be created by the
 * explicit Move to Offer action, so editing a round's result back to pending/rejected must NOT
 * delete it — that would silently throw away a separate recruiter decision (and, once accepted, the
 * placement behind it). Withdrawing an offer is done from Offers & placement.
 */
async function rollbackInterviewSelectionPipeline(meeting) {
  let syncCandidateId = null;
  try {
    const { candidateObjId, application } = await resolveJobApplicationForInterviewRollback(meeting);
    if (!application) {
      return skipUnlinkedSideEffect('rollbackInterviewSelectionPipeline', meeting, candidateObjId);
    }

    if (await Offer.exists({ jobApplication: application._id })) {
      logger.info(
        '[rollbackInterviewSelectionPipeline] Application %s already has an offer — round edit leaves offer/placement untouched (meeting=%s)',
        application._id,
        meeting._id
      );
      return;
    }

    const st = application.status;
    if (st === 'Offered' || st === 'Hired') {
      await JobApplication.updateOne({ _id: application._id }, { $set: { status: 'Interview' } });
      syncCandidateId = candidateObjId;
    }
    logger.info('[rollbackInterviewSelectionPipeline] No offer doc — normalized application status only');
  } catch (err) {
    logger.error('[rollbackInterviewSelectionPipeline] Failed:', err?.message || err);
    throw err;
  }

  if (syncCandidateId) {
    await syncReferralPipelineStatusForCandidate(syncCandidateId);
  }
}

/**
 * Mirror interview rejection onto the linked JobApplication so candidate-facing status matches.
 * @param {object} meeting - Meeting doc (after save)
 */
async function applyInterviewRejectionToApplication(meeting) {
  let syncCandidateId = null;
  try {
    const { candidateObjId, application } = await resolveJobApplicationForInterviewRollback(meeting);
    if (!application) {
      return skipUnlinkedSideEffect('applyInterviewRejectionToApplication', meeting, candidateObjId);
    }
    if (application.status === 'Rejected') {
      return;
    }
    const fromStatus = application.status;
    if (!isAllowedTransition('application', fromStatus, 'Rejected')) {
      logger.warn(
        '[applyInterviewRejectionToApplication] Cannot transition %s → Rejected for application %s',
        fromStatus,
        application._id
      );
      return;
    }
    await JobApplication.updateOne({ _id: application._id }, { $set: { status: 'Rejected' } });
    syncCandidateId = candidateObjId;
    logger.info(
      '[applyInterviewRejectionToApplication] Set application %s to Rejected (meeting=%s)',
      application._id,
      meeting._id
    );
  } catch (err) {
    logger.error('[applyInterviewRejectionToApplication] Failed:', err?.message || err);
    throw err;
  }
  if (syncCandidateId) {
    await syncReferralPipelineStatusForCandidate(syncCandidateId);
  }
}

/**
 * When an interview result reopens from rejected → pending, restore the application to Interview.
 * System-driven (same class as auto-Interview on schedule), not a manual recruiter transition.
 * @param {object} meeting - Meeting doc (after save)
 */
async function reopenApplicationAfterInterviewRejection(meeting) {
  let syncCandidateId = null;
  try {
    const { candidateObjId, application } = await resolveJobApplicationForInterviewRollback(meeting);
    if (!application) {
      return skipUnlinkedSideEffect('reopenApplicationAfterInterviewRejection', meeting, candidateObjId);
    }
    if (application.status !== 'Rejected') {
      return;
    }
    await JobApplication.updateOne({ _id: application._id }, { $set: { status: 'Interview' } });
    syncCandidateId = candidateObjId;
    logger.info(
      '[reopenApplicationAfterInterviewRejection] Restored application %s to Interview (meeting=%s)',
      application._id,
      meeting._id
    );
  } catch (err) {
    logger.error('[reopenApplicationAfterInterviewRejection] Failed:', err?.message || err);
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

const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Human-readable job title for invitation emails — meeting.jobPosition may store a Job ObjectId.
 * @param {string|undefined|null} jobPosition
 * @returns {Promise<string>}
 */
async function resolveJobPositionDisplayTitle(jobPosition) {
  const val = (jobPosition || '').trim();
  if (!val) return '';
  if (!OBJECT_ID_HEX_RE.test(val)) return val;
  const job = await Job.findById(val).select('title').lean();
  return job?.title?.trim() || '—';
}

/** In-app notification payload for interview meetings (relative join path + metadata for legacy fallback). */
const interviewMeetingNotificationFields = (meeting, invite = {}, extra = {}) => ({
  link: getInAppMeetingLink(meeting.meetingId, invite),
  relatedEntity: { type: 'meeting', id: meeting.meetingId },
  metadata: { meetingId: meeting.meetingId, meetingKind: 'interview', ...extra },
});

/**
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
 * Send the interview invitation email + in-app notification to each recipient.
 * Shared by create (all recipients), update (newly-added recipients, or every
 * existing one when the start time moved) and resend, so the paths stay in sync.
 * @param {Object} meeting - Meeting document
 * @param {string[]} emails - lowercased recipient emails
 * @param {Object} [opts]
 * @param {boolean} [opts.rescheduled] - word the mail as a time change, not a first invite
 */
const sendInvitationEmails = async (meeting, emails, { rescheduled = false } = {}) => {
  const scheduled = meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleString() : 'TBD';
  const jobPositionDisplay = await resolveJobPositionDisplayTitle(meeting.jobPosition);
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
      jobPosition: jobPositionDisplay,
      description: meeting.description,
      publicMeetingUrl: personalUrl,
      allowGuestJoin: meeting.allowGuestJoin,
      requireApproval: meeting.requireApproval,
      rescheduled,
      icsContent: buildMeetingIcs(
        {
          id: meeting.meetingId,
          title: meeting.title,
          description: meeting.description,
          scheduledAt: meeting.scheduledAt,
          durationMinutes: meeting.durationMinutes,
          updatedAt: meeting.updatedAt,
        },
        personalUrl,
        to
      ),
    };
    sendMeetingInvitationEmail(to, payload).catch((err) => {
      logger.warn(`Failed to send meeting invitation to ${to}:`, err?.message || err);
    });
    import('./notification.service.js').then(({ notifyByEmail }) => {
      notifyByEmail(to, {
        type: 'meeting',
        title: meeting.title || 'Meeting invitation',
        message: `Scheduled: ${scheduled}`,
        ...interviewMeetingNotificationFields(meeting, { name: inviteName, email: to }),
      }).catch(() => {});
    }).catch(() => {});
  });
};

/**
 * Send cancellation email + METHOD:CANCEL ICS so calendars drop the event.
 * @param {Object} meeting
 * @param {string[]} emails - lowercased recipient emails
 */
const sendCancellationEmails = async (meeting, emails) => {
  const jobPositionDisplay = await resolveJobPositionDisplayTitle(meeting.jobPosition);
  emails.forEach((to) => {
    const inviteName = resolveInviteeDisplayName(meeting, to);
    const payload = {
      title: meeting.title,
      scheduledAt: meeting.scheduledAt,
      timezone: meeting.timezone,
      durationMinutes: meeting.durationMinutes,
      inviteeName: inviteName,
      hostName: meeting.recruiter?.name || meeting.hosts?.[0]?.nameOrRole || '',
      interviewType: meeting.interviewType,
      jobPosition: jobPositionDisplay,
      icsContent: buildMeetingCancelIcs(
        {
          id: meeting.meetingId,
          title: meeting.title,
          description: meeting.description,
          scheduledAt: meeting.scheduledAt,
          durationMinutes: meeting.durationMinutes,
          updatedAt: meeting.updatedAt,
        },
        to
      ),
    };
    sendMeetingCancellationEmail(to, payload).catch((err) => {
      logger.warn(`Failed to send meeting cancellation to ${to}:`, err?.message || err);
    });
  });
};

/**
 * Create a meeting and send invitation emails
 * @param {Object} body - Meeting payload
 * @param {string} userId - Created by user id
 * @returns {Promise<Object>} Meeting with publicMeetingUrl
 */
const interviewApplicationRequired = () =>
  String(process.env.INTERVIEW_APPLICATION_REQUIRED || 'false').toLowerCase() === 'true';

const INTERVIEW_FULL_ACCESS = ['interviews.read', 'interviews.create', 'interviews.edit', 'interviews.delete'];

const transitionApplicationToInterview = async (application, userId, meeting, jobObjId, candId) => {
  if (!application || !['Applied', 'Screening'].includes(application.status)) {
    return;
  }
  const statusBefore = application.status;
  application.status = 'Interview';
  await application.save();
  await syncReferralPipelineStatusForCandidate(candId).catch((err) =>
    logger.warn('referral pipeline sync after interview schedule:', err?.message || err)
  );
  writeAtsAudit(
    String(userId),
    {
      action: ActivityActions.JOB_APPLICATION_UPDATE,
      entityType: EntityTypes.JOB_APPLICATION,
      entityId: String(application._id),
      metadata: {
        source: 'system',
        trigger: 'interview_scheduled',
        statusBefore,
        statusAfter: 'Interview',
        related: {
          jobId: String(jobObjId),
          candidateId: String(candId),
          meetingId: String(meeting._id),
        },
      },
    },
    null,
    { editContext: { staffEdit: true } }
  ).catch((err) => logger.warn('ats_audit jobApplication.interview_scheduled:', err?.message || err));
};

const createMeeting = async (body, userId) => {
  // Transition window (plan §8.5.6, D5): a client that does not send applicationId keeps today's eligibility
  // rules (no application for this candidate + job → 400; Rejected/Offered/Hired → 400). Otherwise it could
  // create interviews that can never be placed (409 interview_not_linked) before the linkage UI exists.
  if (!body.applicationId) {
    await assertInterviewSchedulingAllowed(body.candidate?.id, body.jobPosition);
  }
  const linkage = await deriveSchedulingLinkage({
    applicationId: body.applicationId,
    candidate: body.candidate,
    jobPosition: body.jobPosition,
  });

  if (interviewApplicationRequired() && body.candidate?.id && !linkage.applicationId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'applicationId is required for interview scheduling');
  }

  const interviewLanguage = assertInterviewLanguage(body.interviewLanguage);
  let round = body.round;
  if (linkage.applicationId && (!round || round.index == null)) {
    // Counter-allocated, never count-derived: see allocateRoundIndex (audit M3/M4).
    round = { ...(round || {}), index: await allocateRoundIndex(linkage.applicationId) };
  }
  if (round?.type && !INTERVIEW_ROUND_TYPES.includes(round.type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid round type');
  }

  // Resolve once and pin a copy: see Meeting.rubricSnapshot. A resolution failure must
  // not block scheduling an interview, so it degrades to no snapshot and readers fall
  // back to the default criteria.
  let rubricSnapshot;
  try {
    const resolved = await resolveRubricForRound({
      jobId: linkage.jobId ? String(linkage.jobId) : null,
      roundType: round?.type || null,
    });
    rubricSnapshot = { ...resolved, capturedAt: new Date() };
  } catch (err) {
    logger.warn('[createMeeting] rubric resolution failed; round scheduled without a snapshot', {
      err: err?.message || err,
    });
    rubricSnapshot = undefined;
  }

  const meetingId = await generateUniqueLivekitRoomId();
  const durationMinutes = Number(body.durationMinutes) || 60;
  const creator = await User.findById(userId).select('adminId').lean();
  const tenantId = creator?.adminId || userId;
  const linkageFields = {
    interviewLanguage,
    round,
    rubricSnapshot,
    applicationId: linkage.applicationId,
    jobId: linkage.jobId,
    candidateId: linkage.candidateId,
    linkageStatus: linkage.linkageStatus,
    linkageSource: linkage.linkageSource,
    jobPosition: linkage.jobPosition ?? body.jobPosition,
  };
  if (linkage.linkageStatus === 'verified' || linkage.linkageStatus === 'verified_exact_ids') {
    linkageFields.linkageVerifiedAt = new Date();
    linkageFields.linkageVerifiedBy = userId;
  }

  const meeting = await Meeting.create({
    ...body,
    ...linkageFields,
    durationMinutes,
    meetingId,
    roomName: meetingId, // same as meetingId for LiveKit; satisfies legacy index roomName_1
    createdBy: userId,
    tenantId,
    remindAt: computeRemindAt(body.scheduledAt),
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

  const candId = meeting.candidate?.id;
  const jobObjId = meeting.jobId || null;
  if (linkage.application && candId && jobObjId) {
    try {
      await transitionApplicationToInterview(linkage.application, userId, meeting, jobObjId, candId);
    } catch (err) {
      logger.warn('Failed to update JobApplication to Interview:', err?.message || err);
    }
  }

  // Send invitation emails to everyone (fire-and-forget; log errors)
  sendInvitationEmails(meeting, getInvitationEmails(meeting)).catch((err) => {
    logger.warn('sendInvitationEmails failed:', err?.message || err);
  });

  return meetingObj;
};

/**
 * Query meetings with filter and pagination
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<QueryResult>}
 */
/**
 * Throw 404 if `currentUser` may not access `meeting`. No-op when currentUser is
 * absent (trusted internal call). Prevents cross-tenant enumeration by ObjectId.
 */
const assertMeetingInScope = async (meeting, currentUser) => {
  if (!currentUser || !meeting?._id) return;
  const { filter } = await meetingScope(currentUser, 'read');
  const inScope = await Meeting.exists({ $and: [{ _id: meeting._id }, filter] });
  if (!inScope) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
};

/** Owner row, or email match (public-apply candidates use job creator as owner). */
const findApplicantCandidateForMeetings = async (user) => {
  const userId = user._id || user.id;
  let candidate = await Employee.findOne({ owner: userId });
  if (!candidate) {
    const emailNorm = String(user.email || '').toLowerCase().trim();
    if (emailNorm) {
      candidate = await Employee.findOne({ email: emailNorm });
    }
  }
  return candidate;
};

const buildMyInterviewsCandidateFilter = async (user) => {
  const or = [];
  const emailNorm = String(user.email || '').toLowerCase().trim();
  if (emailNorm) {
    or.push({ 'candidate.email': new RegExp(`^${escapeRegexForJobTitle(emailNorm)}$`, 'i') });
  }
  const candidate = await findApplicantCandidateForMeetings(user);
  if (candidate) {
    or.push({ 'candidate.id': candidate._id.toString() });
  }
  return or.length ? { $or: or } : null;
};

const meetingEndsAt = (scheduledAt, durationMinutes) => {
  const start = new Date(scheduledAt).getTime();
  if (Number.isNaN(start)) return null;
  const mins = Number(durationMinutes) > 0 ? Number(durationMinutes) : 60;
  return new Date(start + mins * 60000);
};

const enrichMeetingForCandidateDashboard = async (meeting) => {
  const doc = meeting.toJSON ? meeting.toJSON() : { ...meeting };
  doc.publicMeetingUrl = getPublicMeetingUrl(doc.meetingId);

  let jobTitle = '';
  let companyName = '';
  const jobPos = (doc.jobPosition || '').trim();
  if (jobPos && OBJECT_ID_HEX_RE.test(jobPos)) {
    const job = await Job.findById(jobPos).select('title organisation').lean();
    jobTitle = job?.title?.trim() || '';
    companyName = job?.organisation?.name?.trim() || '';
  } else if (jobPos) {
    jobTitle = jobPos;
  }
  doc.jobTitle = jobTitle;
  doc.companyName = companyName;
  return doc;
};

const meetingEndStillOpenExpr = (now) => ({
  $gte: [
    {
      $add: [
        '$scheduledAt',
        {
          $multiply: [
            {
              $cond: [{ $gt: ['$durationMinutes', 0] }, '$durationMinutes', 60],
            },
            60000,
          ],
        },
      ],
    },
    now,
  ],
});

const parseMyInterviewsIncludePast = (value) => value === true || value === 'true' || value === '1';

/**
 * Upcoming interviews for the signed-in candidate (auth only — no interviews.read).
 * Default: scheduled rows whose window has not ended and result is not rejected.
 * Optional applicationId scopes to one application; includePast returns ended/cancelled history too.
 */
const queryMyInterviews = async (currentUser, options = {}) => {
  const candidateFilter = await buildMyInterviewsCandidateFilter(currentUser);
  if (!candidateFilter) {
    return { results: [], page: 1, limit: options.limit || 20, totalPages: 0, totalResults: 0 };
  }

  const now = new Date();
  const includePast = parseMyInterviewsIncludePast(options.includePast);
  const and = [candidateFilter, { interviewResult: { $ne: 'rejected' } }];

  const applicationId = options.applicationId ? String(options.applicationId).trim() : '';
  if (applicationId && OBJECT_ID_HEX_RE.test(applicationId)) {
    and.push({ applicationId });
  }

  if (includePast) {
    and.push({ status: { $in: ['scheduled', 'ended', 'cancelled'] } });
  } else {
    and.push({ status: 'scheduled' });
    and.push({ $expr: meetingEndStillOpenExpr(now) });
  }

  const filter = { $and: and };

  const result = await Meeting.paginate(filter, {
    ...options,
    sortBy: options.sortBy || 'scheduledAt:asc',
    limit: options.limit || 20,
    page: options.page || 1,
  });

  result.results = await Promise.all(
    (result.results || []).map((m) => enrichMeetingForCandidateDashboard(m))
  );
  return result;
};

const queryMeetings = async (filter, options, currentUser = null, scopeOptions = {}) => {
  let scopedFilter = filter;
  if (currentUser) {
    const { filter: scope } = await meetingScope(currentUser, 'read', scopeOptions);
    scopedFilter = { $and: [filter || {}, scope] };
  }
  const result = await Meeting.paginate(scopedFilter, {
    ...options,
    // Array form, not the comma string: the paginate plugin splits a string on '.' into a nested
    // populate, which would try to populate `interviewScorecard` itself (not a ref) and throw.
    populate: ['createdBy', { path: 'interviewScorecard.scoredBy', select: 'name email' }],
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
const getMeetingById = async (id, currentUser = null) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) return null;
  await assertMeetingInScope(meeting, currentUser);
  const populated = await Meeting.findById(meeting._id)
    .populate('createdBy')
    .populate({ path: 'interviewScorecard.scoredBy', select: 'name email' });
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
 * [ADR] ensureOfferForApplication: ensures a Draft offer (+ default joining date when missing) for this
 * job application. Placement is created when the offer is Accepted from Offers & Placement — not during
 * this call.
 *
 * Application-scoped on purpose: the offer chain is shared by the explicit Move to Offer action
 * (`applicationOffer.service.js`) and by the interview wrapper below, so both enforce the same guards.
 *
 * @param {Object} application - JobApplication document
 * @param {string} jobId - Job id the application belongs to
 * @param {import('mongoose').Types.ObjectId|string} candidateObjId - Candidate Employee id
 * @param {string} userId - User performing the action
 */
const ensureOfferForApplication = async (application, jobId, candidateObjId, userId) => {
  // Existing (active) employees must NOT enter the offer/placement hire flow — that would create a
  // second hire and a new offer letter. They move via Internal transfer instead. Resigned employees
  // self-applying ARE a rehire, so they fall through to the normal hire flow below.
  const candidateForGuard = await Employee.findById(candidateObjId).select(
    'employeeId referralPipelineStatus isActive'
  );
  if (isExistingEmployee(candidateForGuard) && !isResignedEmployee(candidateForGuard)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This candidate is already an employee. Use Internal transfer instead of the offer/placement flow.'
    );
  }

  // Capacity gate for the whole move, not only the branch that hires. Of this function's seven
  // non-throwing outcomes only one (an existing Sent/Under Negotiation offer with a joining date)
  // actually marks anyone Hired; the rest top up a Draft offer's joining date or mint a new zeroed
  // Draft offer. Those still push a second person down a requisition that has no opening left,
  // which is the state this guard exists to prevent.
  //
  // An application that is already Hired is exempt: it is part of the count, and the Accepted-offer
  // and placement-exists branches below are idempotent re-entries for that same person.
  if (application.status !== 'Hired') {
    await assertJobVacancyCapacity(jobId);
  }

  const existingOffer = await Offer.findOne({ jobApplication: application._id });
  if (existingOffer) {
    if (existingOffer.status === 'Accepted') {
      logger.debug('[ensureOfferForApplication] Offer already accepted, placement exists');
      return;
    }
    if (existingOffer.status === 'Draft') {
      try {
        await ensureInterviewOfferLetterDefaults(existingOffer._id, userId);
        logger.info(
          '[ensureOfferForApplication] Draft offer ensured (joining date); awaiting acceptance in Offers & placement — application %s',
          application._id
        );
      } catch (err) {
        logger.error('[ensureOfferForApplication] Failed to ensure draft offer defaults:', err?.message || err);
        throw err;
      }
      return;
    }
    if (existingOffer.status === 'Sent' || existingOffer.status === 'Under Negotiation') {
      const hasPlacement = await Placement.exists({ offer: existingOffer._id });
      if (hasPlacement) {
        logger.debug('[ensureOfferForApplication] Offer already has placement, skipping');
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
        logger.info('[ensureOfferForApplication] Accepted existing Sent offer for application %s, placement created', application._id);
      } catch (err) {
        logger.error('[ensureOfferForApplication] Failed to accept existing offer:', err?.message || err);
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
    logger.info('[ensureOfferForApplication] Created draft offer for application %s (complete in Offers & placement)', application._id);
  } catch (err) {
    // BUG-8 FIX: race condition — two concurrent requests both passed the existingOffer check.
    // The second call gets "An offer already exists"; treat it as an idempotent success.
    if (
      (err?.statusCode === 400 || err?.status === 400) &&
      /already exists/i.test(err?.message || '')
    ) {
      logger.info('[ensureOfferForApplication] Concurrent offer creation detected for application %s — treating as success', application._id);
      const created = await Offer.findOne({ jobApplication: application._id });
      if (created && created.status !== 'Accepted' && created.status !== 'Rejected') {
        await ensureInterviewOfferLetterDefaults(created._id, userId);
      }
      return;
    }
    logger.error('[ensureOfferForApplication] Failed to create/accept offer:', err?.message || err);
    throw err;
  }
};

/**
 * Interview-scoped entry to the offer chain: resolves this interview's job application, then runs
 * `ensureOfferForApplication`. Never fires automatically from an interview result any more — only
 * the explicit Move to Pre-boarding / internal-transfer actions call it.
 * @deprecated use createPlacementFromInterview name; `moveCandidateToPreboarding` is a backward-compatible alias.
 * @param {Object} meeting - Meeting document (after save)
 * @param {string} userId - User performing the action
 */
const createPlacementFromInterview = async (meeting, userId) => {
  const { candidateObjId, jobId, application } = await resolveJobApplicationForInterviewMeeting(meeting);

  if (!candidateObjId) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Cannot move to Offers & placement: this interview has no valid candidate linked. Edit the interview and choose a candidate.'
    );
  }

  if (!application) {
    if (normalizeLinkageStatus(meeting) === 'unlinked') {
      throw new ApiError(httpStatus.CONFLICT, 'Interview is not linked to a job application', true, '', {
        errorCode: INTERVIEW_NOT_LINKED,
      });
    }
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Cannot move to Offers & placement: no job application found for this candidate. Link an application to this interview first.'
    );
  }

  return ensureOfferForApplication(application, jobId, candidateObjId, userId);
};

/**
 * Notify the candidate when an interview result transitions into 'selected' or 'rejected'.
 * Candidate-facing only: resolves the recipient via the candidate's own email → User account
 * (same resolution jobApplication.service.js uses for status-change notifications) and NEVER
 * falls back to notifying the recruiter/host/job creator. Fire only on the transition edge
 * (guards against duplicate notifications on repeat/no-op updates), never on
 * move-to-preboarding or internal-transfer. Failures are logged and swallowed — must not roll
 * back the interview result that was already saved.
 * @param {Object} meeting - Meeting document (after save)
 * @param {string} previousInterviewResult
 * @param {string} newInterviewResult
 */
const notifyCandidateOfInterviewResultChange = async (meeting, previousInterviewResult, newInterviewResult) => {
  const isNewlySelected = previousInterviewResult !== 'selected' && newInterviewResult === 'selected';
  const isNewlyRejected = previousInterviewResult !== 'rejected' && newInterviewResult === 'rejected';
  if (!isNewlySelected && !isNewlyRejected) return;

  const candidateEmail = meeting.candidate?.email?.trim().toLowerCase();
  if (!candidateEmail) {
    logger.warn(
      '[notifyCandidateOfInterviewResultChange] Meeting %s has no candidate email on file — skipping candidate notification',
      meeting._id
    );
    return;
  }

  try {
    const candidateUser = await User.findOne({ email: candidateEmail }).select('_id').lean();
    if (!candidateUser) {
      logger.warn(
        '[notifyCandidateOfInterviewResultChange] No User account for candidate email %s (meeting %s) — skipping candidate notification',
        candidateEmail,
        meeting._id
      );
      return;
    }

    const jobPositionDisplay = await resolveJobPositionDisplayTitle(meeting.jobPosition);
    const jobTitle = jobPositionDisplay || 'the role';
    const { jobId, application } = await resolveJobApplicationForInterviewMeeting(meeting);

    // A passed round is not an offer since Stage 1 decoupling — the copy must not promise one.
    const { title, message } = isNewlySelected
      ? {
          title: 'Interview Round Passed',
          message: `Good news — you passed your interview round for ${jobTitle}. We'll be in touch about the next step.`,
        }
      : {
          title: 'Application Update',
          message: `Thank you for your time. Your application for ${jobTitle} was not selected to move forward.`,
        };

    const { notify } = await import('./notification.service.js');
    await notify(candidateUser._id, {
      type: 'job_application',
      title,
      message,
      // Explicit link — the job_application resolver falls back to a recruiter-facing
      // /ats/jobs/:id route when metadata.jobId is set, so this must not be left implicit.
      link: '/ats/my-applications',
      metadata: {
        ...(jobId && { jobId }),
        ...(application?._id && { applicationId: application._id.toString() }),
        meetingId: meeting.meetingId,
        interviewResult: newInterviewResult,
      },
    });
  } catch (err) {
    logger.error(
      '[notifyCandidateOfInterviewResultChange] Failed to notify candidate for meeting %s:',
      meeting._id,
      err?.message || err
    );
  }
};

/**
 * Update meeting by id (MongoDB ObjectId or meetingId string)
 * @param {string} id - MongoDB ObjectId or meetingId
 * @param {Object} updateBody
 * @param {string} [userId] - User performing the update (needed for move-to-preboarding)
 * @returns {Promise<Meeting>}
 */
const updateMeetingById = async (id, updateBody, userId, currentUser = null) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);
  const previousInterviewResult = meeting.interviewResult;
  const previousStatus = meeting.status;
  // Snapshot recipients BEFORE applying the edit so we can email only the
  // people newly added in this edit (participants from the user list or guest
  // invites), never re-spam existing invitees.
  const beforeInviteEmails = new Set(getInvitationEmails(meeting));
  const safeBody = { ...updateBody };
  const dur = Number(safeBody.durationMinutes);
  if (Number.isInteger(dur) && dur >= 1 && dur <= 480) {
    safeBody.durationMinutes = dur;
  } else if ('durationMinutes' in safeBody) {
    delete safeBody.durationMinutes;
  }
  // Rubric authorship is server-owned: a client can send ratings/comment, never who scored or when.
  // Stamped on every scorecard write so a later reader sees who owns the score set currently stored.
  if (safeBody.interviewScorecard) {
    safeBody.interviewScorecard = {
      ratings: safeBody.interviewScorecard.ratings || [],
      comment: safeBody.interviewScorecard.comment || '',
      scoredBy: userId || meeting.createdBy || null,
      scoredAt: new Date(),
    };
  }
  const previousScheduledAt = meeting.scheduledAt;
  const previousDurationMinutes = meeting.durationMinutes;
  const previousTitle = meeting.title;
  Object.assign(meeting, safeBody);
  // A moved meeting needs a fresh reminder. Without this the old T-15 already fired for a
  // time that no longer exists, and the new time is never reminded at all, because
  // reminderSentAt is the only thing the scheduler checks.
  const movedTo = meeting.scheduledAt;
  const timeMoved =
    !!previousScheduledAt &&
    !!movedTo &&
    new Date(previousScheduledAt).getTime() !== new Date(movedTo).getTime();
  if (timeMoved) {
    meeting.reminderSentAt = null;
    meeting.remindAt = computeRemindAt(movedTo);
    meeting.reminderRetry = {
      attempts: 0,
      claimedAt: null,
      lastError: null,
      lastErrorAt: null,
      lastErrorCategory: null,
      failedAt: null,
    };
  }
  await meeting.save();

  const afterInviteEmails = getInvitationEmails(meeting);
  const cancelledNow = previousStatus !== 'cancelled' && meeting.status === 'cancelled';
  const calendarChanged =
    Number(previousDurationMinutes) !== Number(meeting.durationMinutes) ||
    String(previousTitle || '') !== String(meeting.title || '');

  if (cancelledNow) {
    const cancelRecipients = new Set([...beforeInviteEmails, ...afterInviteEmails]);
    if (cancelRecipients.size) {
      sendCancellationEmails(meeting, [...cancelRecipients]).catch((err) => {
        logger.warn('sendCancellationEmails failed:', err?.message || err);
      });
    }
  } else {
    const removedEmails = [...beforeInviteEmails].filter((e) => !afterInviteEmails.includes(e));
    if (removedEmails.length) {
      sendCancellationEmails(meeting, removedEmails).catch((err) => {
        logger.warn('sendCancellationEmails (removed invitee) failed:', err?.message || err);
      });
    }
    // No re-spam on edit: newly-added invitees get a first invitation, everyone else stays quiet.
    const newlyAddedEmails = afterInviteEmails.filter((e) => !beforeInviteEmails.has(e));
    if (newlyAddedEmails.length) {
      sendInvitationEmails(meeting, newlyAddedEmails).catch((err) => {
        logger.warn('sendInvitationEmails failed:', err?.message || err);
      });
    }
    // A moved start time or other calendar fields (duration, title) must update existing entries.
    if (timeMoved || calendarChanged) {
      const existingEmails = afterInviteEmails.filter((e) => beforeInviteEmails.has(e));
      if (existingEmails.length) {
        sendInvitationEmails(meeting, existingEmails, { rescheduled: true }).catch((err) => {
          logger.warn('sendInvitationEmails (reschedule) failed:', err?.message || err);
        });
      }
    }
  }

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

  // Single canonical emission point for candidate-facing selected/rejected notifications —
  // do not duplicate this call on the move-to-preboarding or internal-transfer paths.
  await notifyCandidateOfInterviewResultChange(meeting, previousInterviewResult, newInterviewResult);

  // Set when an application side effect was skipped because the interview has no resolvable application.
  let linkageWarning = null;
  if (
    previousInterviewResult === 'selected' &&
    (newInterviewResult === 'pending' || newInterviewResult === 'rejected')
  ) {
    try {
      linkageWarning = (await rollbackInterviewSelectionPipeline(meeting)) || linkageWarning;
    } catch (err) {
      logger.error('[updateMeetingById] rollbackInterviewSelectionPipeline failed:', err?.message || err);
    }
  }

  if (newInterviewResult === 'rejected' && previousInterviewResult !== 'rejected') {
    try {
      linkageWarning = (await applyInterviewRejectionToApplication(meeting)) || linkageWarning;
    } catch (err) {
      logger.error('[updateMeetingById] applyInterviewRejectionToApplication failed:', err?.message || err);
    }
  } else if (newInterviewResult === 'pending' && previousInterviewResult === 'rejected') {
    try {
      linkageWarning = (await reopenApplicationAfterInterviewRejection(meeting)) || linkageWarning;
    } catch (err) {
      logger.error('[updateMeetingById] reopenApplicationAfterInterviewRejection failed:', err?.message || err);
    }
  }

  // Stage 1 decoupling: marking a round "selected" records the round outcome only. Creating the
  // offer is a separate, explicit recruiter decision — POST /job-applications/:id/move-to-offer.
  const result = await getMeetingById(meeting._id.toString());
  if (linkageWarning) result.linkageWarning = linkageWarning;
  return result;
};

/**
 * Delete meeting by id
 * @param {ObjectId} id
 * @returns {Promise<Meeting|null>}
 */
const deleteMeetingById = async (id, currentUser = null) => {
  const meeting = await Meeting.findById(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);
  /**
   * A round that recorded an outcome or an evaluation is hiring evidence, not clutter.
   * Deleting it erased the result and the scorecard with no tombstone (audit M6), so
   * refuse and send the caller to Cancel, which keeps the row and its number.
   *
   * Scheduled rounds nobody has judged are still deletable - that is the mis-booking case.
   */
  const hasDecision = meeting.interviewResult && meeting.interviewResult !== 'pending';
  const hasLegacyScorecard =
    Boolean(meeting.interviewScorecard?.ratings?.length) ||
    Boolean(String(meeting.interviewScorecard?.comment || '').trim());
  if (hasDecision || hasLegacyScorecard) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This round has a recorded result or evaluation and cannot be deleted. Cancel it instead - the round stays in the history.',
      true,
      '',
      { errorCode: 'round_has_record' }
    );
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
const resendMeetingInvitations = async (id, currentUser = null) => {
  const meeting = await Meeting.findById(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);
  if (meeting.status === 'cancelled') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot resend invitations for a cancelled meeting');
  }
  const emails = getInvitationEmails(meeting);
  const scheduled = meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleString() : 'TBD';
  const jobPositionDisplay = await resolveJobPositionDisplayTitle(meeting.jobPosition);
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
        jobPosition: jobPositionDisplay,
        description: meeting.description,
        publicMeetingUrl: personalUrl,
        allowGuestJoin: meeting.allowGuestJoin,
        requireApproval: meeting.requireApproval,
        icsContent: buildMeetingIcs(
          {
            id: meeting.meetingId,
            title: meeting.title,
            description: meeting.description,
            scheduledAt: meeting.scheduledAt,
            durationMinutes: meeting.durationMinutes,
            updatedAt: meeting.updatedAt,
          },
          personalUrl,
          to
        ),
      };
      return sendMeetingInvitationEmail(to, payload)
        .then((delivered) => {
          // `false` means notification preferences suppressed it. Counting that as sent is
          // what made "Invitations resent" report success to someone who received nothing.
          if (delivered !== false) sent += 1;
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
      ...interviewMeetingNotificationFields(meeting, { name: inviteName, email: to }),
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
const moveMeetingToPreboarding = async (id, userId, currentUser = null) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);
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
 * Internal mobility: move a self-applied EXISTING employee into a new role after a selected interview.
 * Updates the same Employee record in place (designation + department), writes an immutable
 * EmployeeTransfer history row, marks the application Hired — NO new Offer, NO new Placement,
 * reuses the existing employeeId. External candidates and resigned employees are rejected here
 * (they use the offer/placement hire flow).
 *
 * @param {string} id - Meeting id (ObjectId or meetingId)
 * @param {string} userId - User performing the transfer (approver)
 * @param {{ designation?: string, departmentId?: string, effectiveDate?: string }} [body]
 * @param {object|null} [currentUser]
 * @returns {Promise<{ transferred: boolean, message: string, transferId: any }>}
 */
const transferEmployeeInternally = async (id, userId, body = {}, currentUser = null) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);
  if (meeting.interviewResult !== 'selected') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Interview result must be "Selected" to transfer the employee');
  }
  if (!meeting.candidate?.id) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Meeting has no candidate linked');
  }

  const { candidateObjId, jobId, application } = await resolveJobApplicationForInterviewMeeting(meeting);
  if (!candidateObjId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This interview has no valid candidate linked.');
  }
  if (!application) {
    if (normalizeLinkageStatus(meeting) === 'unlinked') {
      throw new ApiError(httpStatus.CONFLICT, 'Interview is not linked to a job application', true, '', {
        errorCode: INTERVIEW_NOT_LINKED,
      });
    }
    throw new ApiError(httpStatus.BAD_REQUEST, 'No job application found for this candidate.');
  }

  const employee = await Employee.findById(candidateObjId);
  if (!employee) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Employee record not found.');
  }
  if (!isExistingEmployee(employee)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This person is not an existing employee. Use the hire flow (Move to pre-boarding), not Internal transfer.'
    );
  }
  if (isResignedEmployee(employee)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This employee is resigned. Use the rehire (offer/placement) flow, not Internal transfer.'
    );
  }

  // Capacity gate, placed before any mutation below. An internal transfer fills the same requisition
  // a new hire would, so it consumes a vacancy. It must throw here rather than beside the
  // application write at the end: by that point the employee's designation, position and department
  // have already been saved, and a refusal there would leave a half-applied transfer.
  //
  // Exempt when this application is already Hired, mirroring the pre-boarding move. The write at the
  // end of this function is deliberately idempotent (`if (application.status !== 'Hired')`), so
  // re-running a transfer to correct a designation or department is a supported action; guarding it
  // unconditionally would refuse that with a capacity error naming the very person re-running it.
  if (application.status !== 'Hired') {
    await assertJobVacancyCapacity(jobId);
  }

  // Resolve the new role: explicit body overrides win; otherwise default the title from the source job.
  let newDesignation = (body.designation || '').trim() || null;
  if (!newDesignation && jobId) {
    const job = await Job.findById(jobId).select('title').lean();
    if (job?.title) newDesignation = job.title;
  }
  const newDepartmentId = body.departmentId || null;

  const oldDesignation = employee.designation || null;
  const oldDepartmentId = employee.departmentId || null;
  const oldDepartment = employee.department || null;

  // Apply changes in place. setEmployeeDepartment dual-writes departmentId + name; designation is plain.
  // A plain save never sets $locals.assignEmployeeIdNow, so the permanent employeeId is untouched.
  if (newDepartmentId) {
    await setEmployeeDepartment(employee, newDepartmentId);
  }
  if (newDesignation) {
    employee.designation = newDesignation;
    // Keep the structured Position ref in sync with the designation string, mirroring the canonical
    // employee-update path (employee.service.js) so the ATS Employee profile + org chart reflect the move.
    employee.position = await resolvePositionIdFromDesignationTitle(newDesignation);
  }
  await employee.save();

  // System action: mark the application Hired directly (the manual transition guard only applies to the
  // recruiter dropdown; pipeline-driving system actions set status directly, like interview scheduling).
  if (application.status !== 'Hired') {
    application.status = 'Hired';
    await application.save();
    queueJobOwnerVacancyFilledNotify(jobId);
  }
  await syncReferralPipelineStatusForCandidate(candidateObjId);

  const transfer = await EmployeeTransfer.create({
    employee: employee._id,
    oldDesignation,
    newDesignation: employee.designation || null,
    oldDepartmentId,
    newDepartmentId: employee.departmentId || null,
    oldDepartment,
    newDepartment: employee.department || null,
    sourceJobId: jobId || null,
    sourceApplicationId: application._id,
    sourceInterviewId: meeting._id,
    transferType: 'internal_transfer',
    effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : new Date(),
    approvedBy: userId || null,
    tenantId: application.tenantId || null,
  });

  // Fail-soft audit trail (entityType Candidate — the Employee collection is `candidates`).
  try {
    await createActivityLog(userId, ActivityActions.EMPLOYEE_TRANSFER, EntityTypes.CANDIDATE, employee._id, {
      transferId: transfer._id,
      from: { designation: oldDesignation, department: oldDepartment },
      to: { designation: employee.designation, department: employee.department },
      sourceJobId: jobId || null,
      sourceApplicationId: application._id,
      sourceInterviewId: meeting._id,
    });
  } catch (_) {
    /* activity log is best-effort */
  }

  return { transferred: true, message: 'Employee transferred internally', transferId: transfer._id };
};

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
    if (!meeting.interviewCompletedAt) {
      meeting.interviewCompletedAt = new Date();
    }
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
  internal.endedAt = new Date();
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

  const hardCapMinutes = config.livekit?.meetingAutoEndHardCapMinutes ?? 120;
  const nowMs = now.getTime();

  let count = 0;
  for (const m of meetings) {
    try {
      const scheduledEndMs =
        new Date(m.scheduledAt).getTime() + (Number(m.durationMinutes) || 0) * 60 * 1000;
      const humanCount = await countHumanParticipants(m.meetingId);
      const action = decideAutoEnd({ humanCount, now: nowMs, scheduledEndMs, hardCapMinutes });
      if (action === 'wait') {
        logger.info('[autoEndExpiredMeetings] waiting for humans to disconnect', {
          meetingId: m.meetingId,
          humanCount,
        });
        continue;
      }
      if (action === 'end_hard_cap') {
        await Recording.updateMany(
          { meetingId: m.meetingId, status: { $nin: RECORDING_TERMINAL } },
          { $set: { truncatedAtScheduleEnd: true } }
        );
      }
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
      logger.info(`[autoEndExpiredMeetings] Auto-ended meeting ${m.meetingId} (${m.title})`, { action });
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
 * Reminder pass. For every scheduled interview whose remindAt has come due,
 * lease-claim it, deliver email + in-app reminders through the dispatcher, and
 * record success / retry / failure. A failed send stays due, so the retry lease
 * and REMINDER_MAX_ATTEMPTS are reachable — under the old band a send that failed
 * near the window's edge was simply lost.
 * @returns {Promise<{sent:number, retried:number, failed:number, staleRecovered:number}>}
 */
export const sendUpcomingMeetingReminders = async () => {
  const now = new Date();
  const leaseFloor = new Date(now.getTime() - reminderLeaseTtlMs());

  const meetings = await Meeting.find({
    status: 'scheduled',
    reminderSentAt: null,
    remindAt: { $ne: null, $lte: now },
    'reminderRetry.attempts': { $lt: REMINDER_MAX_ATTEMPTS },
    $or: [{ 'reminderRetry.claimedAt': null }, { 'reminderRetry.claimedAt': { $lt: leaseFloor } }],
  })
    .limit(200)
    .lean();

  // `skipped` counts meetings marked reminded with nothing actually sent — every recipient
  // opted out, or the meeting had no resolvable address at all.
  const stats = { sent: 0, skipped: 0, retried: 0, failed: 0, staleRecovered: 0 };
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

    // A reminder for an interview that already started is not worth sending: a scheduler
    // that was down should not deliver "starts soon" after the fact. The claim retires it.
    if (new Date(m.scheduledAt).getTime() <= now.getTime()) {
      // eslint-disable-next-line no-await-in-loop
      await Meeting.updateOne(
        { _id: m._id },
        { $set: { reminderSentAt: now, 'reminderRetry.claimedAt': null } }
      );
      stats.skipped += 1;
      logger.info(`Reminder suppressed for ${m.meetingId}: interview already started`);
      // eslint-disable-next-line no-continue
      continue;
    }

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
        let notified = false;
        if (user?._id) {
          try {
            await notify(user._id, {
              type: 'meeting_reminder',
              title: 'Interview reminder',
              message,
              ...interviewMeetingNotificationFields(m, { name: inviteName, email }),
            });
            notified = true;
          } catch (err) {
            logger.warn(`T-10 in-app notify failed for ${email}: ${err?.message || err}`);
          }
        }
        const emailed = await sendMeetingReminderEmail(email, {
          title,
          scheduledAt: m.scheduledAt,
          timezone: m.timezone || 'UTC',
          publicMeetingUrl: link,
          inviteeName: inviteName,
        });
        // false only when both channels declined: the recipient has no account and has
        // opted out of reminder email. Reported as skipped, never as delivered.
        return emailed || notified;
      },
    });

    if (result.ok) {
      await Meeting.updateOne(
        { _id: m._id },
        { $set: { reminderSentAt: now, 'reminderRetry.claimedAt': null } }
      );
      if (result.delivered > 0) stats.sent += 1;
      else stats.skipped += 1;
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
 * Conclusion recipients. `recruiter.id` and `agents[].id` are free-form Strings on the
 * model — external/mock ids like "1" are legal — so anything that is not an ObjectId is
 * dropped from the in-app list rather than handed to User.findById, which would throw a
 * CastError and burn all three delivery attempts.
 * @param {Object} meeting
 * @returns {Array<{kind:'email', email:string}|{kind:'inApp', userId:string}>}
 */
export const buildConclusionRecipients = (meeting) => {
  const emails = new Set();
  const userIds = new Set();
  const addUser = (id) => {
    const s = id == null ? '' : String(id);
    if (mongoose.Types.ObjectId.isValid(s)) userIds.add(s);
  };
  if (meeting.recruiter?.email) emails.add(String(meeting.recruiter.email).trim().toLowerCase());
  addUser(meeting.recruiter?.id);
  for (const a of meeting.agents || []) {
    if (a?.email) emails.add(String(a.email).trim().toLowerCase());
    addUser(a?.id);
  }
  addUser(meeting.createdBy);
  return [
    ...[...emails].map((email) => ({ kind: 'email', email })),
    ...[...userIds].map((userId) => ({ kind: 'inApp', userId })),
  ];
};

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

    const recipients = buildConclusionRecipients(m);

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
            link: '/ats/interviews',
            relatedEntity: { type: 'meeting', id: m.meetingId },
            metadata: {
              meetingId: m.meetingId,
              meetingKind: 'interview',
              navTarget: 'interviews_list',
            },
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

const meetingHasRecording = async (meeting) => {
  const room = meeting.meetingId || meeting.roomName;
  if (!room) return false;
  const rec = await Recording.findOne({
    meetingId: room,
    status: { $nin: ['aborted', 'failed', 'missing', 'expired'] },
  })
    .select('_id')
    .lean();
  return Boolean(rec);
};

const getMeetingLinkage = async (id, currentUser) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);
  return {
    applicationId: meeting.applicationId,
    jobId: meeting.jobId,
    candidateId: meeting.candidateId,
    round: meeting.round,
    interviewLanguage: meeting.interviewLanguage || 'en',
    linkageStatus: normalizeLinkageStatus(meeting),
    linkageSource: meeting.linkageSource,
    linkageRevision: meeting.linkageRevision ?? 0,
    linkageVerifiedAt: meeting.linkageVerifiedAt,
  };
};

const patchMeetingLinkage = async (id, body, userId, currentUser) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);

  const hasRecording = await meetingHasRecording(meeting);
  const fullAccess = await hasAllApiPermissions(currentUser, INTERVIEW_FULL_ACCESS);
  if (hasRecording && !fullAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Linkage cannot be changed after a recording exists');
  }

  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'expectedRevision is required');
  }

  const updates = {};
  const changes = [];

  if (body.interviewLanguage !== undefined) {
    updates.interviewLanguage = assertInterviewLanguage(body.interviewLanguage);
    changes.push({ field: 'interviewLanguage', from: meeting.interviewLanguage, to: updates.interviewLanguage });
  }
  if (body.round !== undefined) {
    if (body.round?.type && !INTERVIEW_ROUND_TYPES.includes(body.round.type)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid round type');
    }
    updates.round = body.round;
    changes.push({ field: 'round', from: meeting.round, to: body.round });
  }

  if (body.applicationId !== undefined) {
    // Linking is not scheduling: an interview that already happened may belong to an Offered/Hired/Rejected
    // application, and that is exactly the case the placement 409 sends recruiters here to fix.
    const linkage = await deriveSchedulingLinkage({
      applicationId: body.applicationId,
      candidate: meeting.candidate,
      jobPosition: meeting.jobPosition,
      enforceEligibility: false,
    });
    const meetingCand = meeting.candidate?.id;
    if (meetingCand && linkage.candidateId && String(linkage.candidateId) !== String(meetingCand)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Application candidate does not match interview candidate');
    }
    // An interview linked after the fact joined the application's history with no round
    // number: it sorted last whenever it happened, and it inflated the old count so the
    // next scheduled round skipped a number (audit M5). Allocate one now, unless this
    // PATCH supplies a round explicitly or the meeting already has an index.
    const linkingToNewApplication =
      String(linkage.applicationId || '') !== String(meeting.applicationId || '');
    if (linkingToNewApplication && updates.round?.index == null && meeting.round?.index == null) {
      const allocatedIndex = await allocateRoundIndex(linkage.applicationId);
      if (allocatedIndex != null) {
        const existingRound = updates.round || meeting.round?.toObject?.() || meeting.round || {};
        updates.round = { ...existingRound, index: allocatedIndex };
      }
    }
    updates.applicationId = linkage.applicationId;
    updates.jobId = linkage.jobId;
    updates.candidateId = linkage.candidateId;
    updates.linkageStatus = 'verified_manual';
    updates.linkageSource = 'manual_link';
    updates.linkageVerifiedAt = new Date();
    updates.linkageVerifiedBy = userId;
    updates.jobPosition = linkage.jobPosition ?? meeting.jobPosition;
    changes.push({
      field: 'applicationId',
      from: meeting.applicationId ? String(meeting.applicationId) : null,
      to: String(linkage.applicationId),
    });
  }

  if (!Object.keys(updates).length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No linkage fields to update');
  }

  const updated = await Meeting.findOneAndUpdate(
    {
      _id: meeting._id,
      linkageRevision: linkageRevisionQuery(expectedRevision),
    },
    { $set: updates, $inc: { linkageRevision: 1 } },
    { new: true }
  );
  if (!updated) {
    throw new ApiError(httpStatus.CONFLICT, 'Linkage revision conflict', true, '', {
      errorCode: 'linkage_revision_conflict',
    });
  }

  await writeAtsAudit(
    String(userId),
    {
      action: ActivityActions.INTERVIEW_LINKAGE_UPDATE,
      entityType: EntityTypes.MEETING,
      entityId: String(meeting._id),
      metadata: { changes },
    },
    null,
    { editContext: { staffEdit: true } }
  ).catch((err) => logger.warn('ats_audit interview.linkage.update:', err?.message || err));

  return getMeetingLinkage(String(updated._id), currentUser);
};

const createExplicitApplicationForMeeting = async (id, userId, currentUser) => {
  const meeting = await resolveMeetingByIdOrMeetingId(id);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  await assertMeetingInScope(meeting, currentUser);

  if (meeting.applicationId) {
    throw new ApiError(httpStatus.CONFLICT, 'Interview is already linked to an application', true, '', {
      errorCode: 'interview_already_linked',
      details: { applicationId: String(meeting.applicationId) },
    });
  }
  const candId = meeting.candidate?.id;
  const jobPos = (meeting.jobPosition || '').trim();
  if (!candId || !mongoose.Types.ObjectId.isValid(candId) || !/^[0-9a-fA-F]{24}$/.test(jobPos)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Interview needs a candidate and a 24-character job id in jobPosition');
  }

  let application;
  try {
    // The real caller: createJobApplication authorises through isOwnerOrAdmin (roles + authContext permissions).
    // Its own existing-row check plus the unique { job, candidate } index cover concurrent creates.
    application = await jobApplicationService.createJobApplication(
      { job: jobPos, candidate: candId, status: 'Interview' },
      currentUser
    );
  } catch (err) {
    if (err?.code === 11000 || err?.statusCode === httpStatus.CONFLICT) {
      const dup = await JobApplication.findOne({
        candidate: new mongoose.Types.ObjectId(candId),
        job: new mongoose.Types.ObjectId(jobPos),
      })
        .select('_id')
        .lean();
      throw new ApiError(httpStatus.CONFLICT, 'Application already exists for this candidate and job', true, '', {
        errorCode: 'application_exists',
        details: { applicationId: dup ? String(dup._id) : null },
      });
    }
    throw err;
  }

  // Audit the application as soon as it exists: it stays even if linking the meeting below loses a race.
  await writeAtsAudit(
    String(userId),
    {
      action: ActivityActions.INTERVIEW_APPLICATION_CREATE,
      entityType: EntityTypes.JOB_APPLICATION,
      entityId: String(application._id),
      metadata: {
        meetingId: String(meeting._id),
        jobId: jobPos,
        candidateId: candId,
      },
    },
    null,
    { editContext: { staffEdit: true } }
  ).catch((err) => logger.warn('ats_audit interview.application.create:', err?.message || err));

  const revision = meeting.linkageRevision ?? 0;
  const updated = await Meeting.findOneAndUpdate(
    { _id: meeting._id, linkageRevision: linkageRevisionQuery(revision) },
    {
      $set: {
        applicationId: application._id,
        jobId: new mongoose.Types.ObjectId(jobPos),
        candidateId: new mongoose.Types.ObjectId(candId),
        linkageStatus: 'verified',
        linkageSource: 'explicit_application_created',
        linkageVerifiedAt: new Date(),
        linkageVerifiedBy: userId,
      },
      $inc: { linkageRevision: 1 },
    },
    { new: true }
  );
  if (!updated) {
    // The application was created; the client refetches the linkage and links it with PATCH.
    throw new ApiError(httpStatus.CONFLICT, 'Linkage revision conflict', true, '', {
      errorCode: 'linkage_revision_conflict',
      details: { applicationId: String(application._id) },
    });
  }

  return getMeetingLinkage(String(updated._id), currentUser);
};

/**
 * LiveKit `room_finished` means the room is gone — keep the Meeting row in sync when
 * hosts/participants disconnect without calling the public end endpoint.
 */
const markMeetingEndedWhenRoomFinished = async (roomName) => {
  if (!roomName || roomName.startsWith('chat-')) {
    return { modified: false };
  }
  const now = new Date();
  const res = await Meeting.updateOne(
    { meetingId: roomName, status: 'scheduled' },
    { $set: { status: 'ended', interviewCompletedAt: now } }
  );
  if (res.modifiedCount) {
    logger.info('[markMeetingEndedWhenRoomFinished] Meeting marked ended', { roomName });
    return { modified: true };
  }
  return { modified: false };
};

export {
  createMeeting,
  getMeetingLinkage,
  patchMeetingLinkage,
  createExplicitApplicationForMeeting,
  queryMyInterviews,
  queryMeetings,
  getMeetingById,
  getMeetingByMeetingId,
  updateMeetingById,
  deleteMeetingById,
  resendMeetingInvitations,
  moveMeetingToPreboarding,
  transferEmployeeInternally,
  ensureOfferForApplication,
  createPlacementFromInterview,
  moveCandidateToPreboarding,
  getPublicMeetingUrl,
  endMeetingByRoomPublic,
  markMeetingEndedWhenRoomFinished,
  autoEndExpiredMeetings,
  getInvitationEmails,
  resolveJobPositionDisplayTitle,
};
