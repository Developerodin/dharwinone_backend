import mongoose from 'mongoose';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import JobApplication from '../models/jobApplication.model.js';
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

  if (meeting.applicationId && mongoose.Types.ObjectId.isValid(String(meeting.applicationId))) {
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
