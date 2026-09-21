import mongoose from 'mongoose';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import JobApplication from '../models/jobApplication.model.js';
import Job from '../models/job.model.js';
import RubricTemplate from '../models/rubricTemplate.model.js';
import { attachRubricCopyToPlanRows } from '../constants/interviewRoundPlan.js';
import Meeting from '../models/meeting.model.js';
import { getInterviewSchedulingBlockReason } from '../constants/atsPipeline.js';
import {
  INTERVIEW_LINKAGE_STATUSES,
  SUPPORTED_INTERVIEW_LANGUAGES,
} from '../constants/interviewLinkage.js';

/**
 * Treat missing linkageStatus like legacy/unlinked.
 */
export function normalizeLinkageStatus(meeting) {
  const status = meeting?.linkageStatus;
  if (!status) return 'unlinked';
  return status;
}

export function isVerifiedLinkage(meeting) {
  const s = normalizeLinkageStatus(meeting);
  return s === 'verified' || s === 'verified_exact_ids' || s === 'verified_manual';
}

/**
 * Resolve application for an interview — never title regex, never any-application fallback, never create.
 */
export async function resolveInterviewApplication(meeting) {
  if (!meeting) {
    return { candidateObjId: null, jobId: null, application: null };
  }

  const candidateId = meeting.candidate?.id;
  const candidateObjId =
    candidateId && mongoose.Types.ObjectId.isValid(candidateId)
      ? new mongoose.Types.ObjectId(candidateId)
      : null;

  if (
    meeting.applicationId &&
    mongoose.Types.ObjectId.isValid(String(meeting.applicationId)) &&
    isVerifiedLinkage(meeting)
  ) {
    const application = await JobApplication.findById(meeting.applicationId);
    if (!application) {
      return {
        candidateObjId,
        jobId: null,
        application: null,
        reason: 'application_deleted',
      };
    }
    const appCandidateId =
      application.candidate?._id?.toString?.() ?? String(application.candidate);
    const jobId = application.job?._id?.toString?.() ?? String(application.job);
    const resolvedCandidate =
      appCandidateId && mongoose.Types.ObjectId.isValid(appCandidateId)
        ? new mongoose.Types.ObjectId(appCandidateId)
        : candidateObjId;
    return {
      candidateObjId: resolvedCandidate,
      jobId,
      application,
      reason: application ? undefined : 'unlinked',
    };
  }

  const jobPos = (meeting.jobPosition || '').trim();
  const meetingCandidateId = meeting.candidateId
    ? String(meeting.candidateId)
    : candidateObjId?.toString() || null;

  if (
    jobPos &&
    /^[0-9a-fA-F]{24}$/.test(jobPos) &&
    meetingCandidateId &&
    mongoose.Types.ObjectId.isValid(meetingCandidateId)
  ) {
    const application = await JobApplication.findOne({
      candidate: new mongoose.Types.ObjectId(meetingCandidateId),
      job: new mongoose.Types.ObjectId(jobPos),
    });
    return {
      candidateObjId: new mongoose.Types.ObjectId(meetingCandidateId),
      jobId: jobPos,
      application,
      reason: application ? undefined : 'unlinked',
    };
  }

  return { candidateObjId, jobId: null, application: null, reason: 'unlinked' };
}

/**
 * @param {{ applicationId?: string, candidate?: object, jobPosition?: string, enforceEligibility?: boolean }} input
 *   enforceEligibility: scheduling checks the application status; linking an existing interview does not.
 */
export async function deriveSchedulingLinkage({ applicationId, candidate, jobPosition, enforceEligibility = true }) {
  if (applicationId) {
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid applicationId');
    }
    const application = await JobApplication.findById(applicationId);
    if (!application) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Application not found');
    }
    const appCandidateId = application.candidate?._id?.toString?.() ?? String(application.candidate);
    const candId = candidate?.id;
    if (candId && mongoose.Types.ObjectId.isValid(candId) && candId !== appCandidateId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Candidate does not own this application');
    }
    const blockReason = enforceEligibility ? getInterviewSchedulingBlockReason(application.status) : null;
    if (blockReason) {
      throw new ApiError(httpStatus.BAD_REQUEST, blockReason);
    }
    const jobId = application.job?._id?.toString?.() ?? String(application.job);
    return {
      applicationId: application._id,
      jobId: new mongoose.Types.ObjectId(jobId),
      candidateId: new mongoose.Types.ObjectId(appCandidateId),
      linkageStatus: 'verified',
      linkageSource: 'scheduled_with_application',
      jobPosition: jobId,
      application,
    };
  }

  const candId = candidate?.id;
  const jobPos = (jobPosition || '').trim();
  if (candId && mongoose.Types.ObjectId.isValid(candId) && jobPos && /^[0-9a-fA-F]{24}$/.test(jobPos)) {
    const application = await JobApplication.findOne({
      candidate: new mongoose.Types.ObjectId(candId),
      job: new mongoose.Types.ObjectId(jobPos),
    });
    if (application) {
      const blockReason = enforceEligibility ? getInterviewSchedulingBlockReason(application.status) : null;
      if (blockReason) {
        throw new ApiError(httpStatus.BAD_REQUEST, blockReason);
      }
      return {
        applicationId: application._id,
        jobId: new mongoose.Types.ObjectId(jobPos),
        candidateId: new mongoose.Types.ObjectId(candId),
        linkageStatus: 'verified_exact_ids',
        jobPosition: jobPos,
        application,
      };
    }
  }

  return {
    applicationId: undefined,
    jobId: undefined,
    candidateId:
      candId && mongoose.Types.ObjectId.isValid(candId) ? new mongoose.Types.ObjectId(candId) : undefined,
    linkageStatus: 'unlinked',
    linkageSource: undefined,
    jobPosition: jobPos || undefined,
  };
}

export function assertInterviewLanguage(language) {
  const lang = language || 'en';
  if (!SUPPORTED_INTERVIEW_LANGUAGES.includes(lang)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Unsupported interview language');
  }
  return lang;
}

/**
 * Allocate the next round index for an application.
 *
 * Counting live meetings (the old defaultRoundIndexForApplication) reissued a number
 * after a cancellation and collided under concurrency. This increments a persisted
 * counter instead, so the only shared step is an atomic $inc.
 *
 * The seed pass reads the highest index EVER used, cancelled rounds included. If two
 * processes seed at once they compute the same value, and the $inc that follows is
 * atomic either way.
 *
 * @param {import('mongoose').Types.ObjectId|string} applicationId
 * @returns {Promise<number|null>} the allocated index, or null when the application is gone
 */
export async function allocateRoundIndex(applicationId) {
  if (!applicationId) return null;
  const current = await JobApplication.findById(applicationId).select('roundCounter').lean();
  if (!current) return null;

  if (!Number(current.roundCounter)) {
    const [highest] = await Meeting.find({ applicationId })
      .sort({ 'round.index': -1 })
      .limit(1)
      .select('round.index')
      .lean();
    const seed = Number(highest?.round?.index) || 0;
    if (seed > 0) {
      await JobApplication.updateOne(
        { _id: applicationId, $or: [{ roundCounter: { $lte: 0 } }, { roundCounter: { $exists: false } }] },
        { $set: { roundCounter: seed } }
      );
    }
  }

  const bumped = await JobApplication.findByIdAndUpdate(
    applicationId,
    { $inc: { roundCounter: 1 } },
    { new: true, select: 'roundCounter' }
  ).lean();
  return Number(bumped?.roundCounter) || null;
}

/** A Job.interviewRounds list with each row's rubric copied for a snapshot. */
const planRowsFromJob = async (job) => {
  const rows = job?.interviewRounds || [];
  const ids = rows.map((r) => r?.templateId).filter(Boolean);
  let templates = [];
  if (ids.length) {
    templates = await RubricTemplate.find({ _id: { $in: ids } }).lean();
  }
  return attachRubricCopyToPlanRows(rows, templates);
};

/**
 * The round sequence in force for this application, WITHOUT capturing it.
 *
 * The snapshot wins once it exists — that is the whole point of freezing it (audit R7).
 * Before it exists, the job's live plan is genuinely what is in force, and the schedule
 * form needs it to be able to offer a first round at all.
 *
 * Read-only on purpose. Capture belongs to ensureRoundPlanSnapshot, which is called only
 * from the schedule path — a GET must never write.
 *
 * @param {string} applicationId
 * @returns {Promise<Array<{key: string, label: string, roundType: string|null}>>}
 */
export const planInForce = async (applicationId) => {
  if (!applicationId) return [];
  const application = await JobApplication.findById(applicationId).select('roundPlanSnapshot job').lean();
  const captured = application?.roundPlanSnapshot?.rounds;
  if (Array.isArray(captured) && captured.length) return captured;

  const jobId = application?.job?._id ?? application?.job ?? null;
  if (!jobId || !mongoose.Types.ObjectId.isValid(String(jobId))) return [];
  const job = await Job.findById(jobId).select('interviewRounds').lean();
  return planRowsFromJob(job);
};

/**
 * The round sequence in force for this application, capturing it on first call.
 *
 * Claimed once with a conditional update, the same discipline as allocateRoundIndex: two
 * recruiters scheduling this application's first round at the same moment must end up with
 * ONE snapshot, not a race in which the later write silently replaces the earlier and
 * changes which rounds the first meeting belongs to.
 *
 * Returns an empty array when the job plans no rounds, which readers treat as "no plan"
 * and fall back to the pre-plan rule (audit R3). An empty array is NOT stored, so a job
 * that gains a plan later still captures it on that application's next round.
 *
 * @param {string} applicationId
 * @param {string|null} jobId
 * @returns {Promise<Array<{key: string, label: string, roundType: string|null}>>}
 */
export const ensureRoundPlanSnapshot = async (applicationId, jobId) => {
  if (!applicationId) return [];

  const existing = await JobApplication.findById(applicationId).select('roundPlanSnapshot').lean();
  const captured = existing?.roundPlanSnapshot?.rounds;
  if (Array.isArray(captured) && captured.length) return captured;

  // The explicit jobId from the linkage is preferred — it is the job this round is being
  // scheduled against, which is authoritative even if the application's own job pointer
  // is stale. Fall back to planInForce, which reads the application's job.
  let rounds = [];
  if (jobId && mongoose.Types.ObjectId.isValid(String(jobId))) {
    rounds = await planRowsFromJob(await Job.findById(jobId).select('interviewRounds').lean());
  }
  if (!rounds.length) rounds = await planInForce(applicationId);
  if (!rounds.length) return [];

  // Claim it: only write when nobody else already has. The $or covers the three shapes a
  // never-captured application can be in (absent, null, empty).
  await JobApplication.updateOne(
    {
      _id: applicationId,
      $or: [
        { 'roundPlanSnapshot.rounds': { $exists: false } },
        { 'roundPlanSnapshot.rounds': { $size: 0 } },
      ],
    },
    { $set: { roundPlanSnapshot: { capturedAt: new Date(), rounds } } }
  );

  // Read back rather than trusting the write: if a concurrent caller won the claim, theirs
  // is the sequence in force and ours must be discarded.
  const after = await JobApplication.findById(applicationId).select('roundPlanSnapshot').lean();
  return after?.roundPlanSnapshot?.rounds || rounds;
};

export async function defaultRoundIndexForApplication(applicationId) {
  const count = await Meeting.countDocuments({
    applicationId,
    status: { $ne: 'cancelled' },
  });
  return count + 1;
}

export function linkageStatusAllowed(value) {
  return !value || INTERVIEW_LINKAGE_STATUSES.includes(value);
}

/** Mongo filter for optimistic linkage PATCH (revision 0 matches missing field). */
export function linkageRevisionQuery(expectedRevision) {
  if (expectedRevision === 0) {
    return { $in: [0, null] };
  }
  return expectedRevision;
}

/**
 * Pure backfill classifier for title-based legacy interviews (no DB).
 * @returns {'legacy_title_candidate'|'ambiguous'|'unlinked_title'}
 */
export function classifyTitleJobPositionBackfill({ jobPosition, candidateId, matchingJobCount, hasApplication }) {
  const jobPos = (jobPosition || '').trim();
  const candidateHex = candidateId;
  if (!jobPos || /^[0-9a-fA-F]{24}$/.test(jobPos)) {
    return 'unlinked_title';
  }
  if (!candidateHex || !/^[0-9a-fA-F]{24}$/.test(candidateHex)) {
    return 'unlinked_title';
  }
  if (matchingJobCount > 1) {
    return 'ambiguous';
  }
  if (matchingJobCount === 1 && hasApplication) {
    return 'legacy_title_candidate';
  }
  if (matchingJobCount === 1) {
    return 'unlinked_title';
  }
  return 'ambiguous';
}
