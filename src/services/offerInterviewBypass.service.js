import Meeting from '../models/meeting.model.js';
import { meetingMatchesApplication } from '../utils/candidateApplicationInterviewResult.js';
import { writeAtsAudit } from './atsAudit.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import logger from '../config/logger.js';

const applicationMeta = (application) => {
  const plain = application?.toObject?.() ?? application ?? {};
  const candidateId = String(plain.candidate?._id ?? plain.candidate?.id ?? plain.candidate ?? '');
  const jobId = String(plain.job?._id ?? plain.job?.id ?? plain.job ?? '');
  const jobTitle = plain.job?.title || '';
  return { plain, candidateId, jobId, jobTitle };
};

/** True when a non-cancelled meeting for this application already has interviewResult selected. */
export async function applicationHasSelectedInterview(application) {
  const { plain, candidateId, jobId, jobTitle } = applicationMeta(application);
  if (!candidateId) return false;

  const meetings = await Meeting.find({
    'candidate.id': candidateId,
    status: { $ne: 'cancelled' },
  })
    .select('candidate jobPosition applicationId interviewResult status')
    .lean();

  return meetings.some(
    (m) =>
      meetingMatchesApplication(
        m,
        {
          candidateId,
          jobId,
          jobTitle,
          applicationId: String(plain._id || plain.id || ''),
        },
        { allowTitleMatch: false }
      ) && m.interviewResult === 'selected'
  );
}

/**
 * Record that an offer was created for an application with no interview round marked selected.
 *
 * Audit only. It deliberately does NOT invent or mutate a Meeting: fabricating
 * `interviewResult: 'selected'` made the bypass invisible in the interview record and let the
 * pipeline claim a round had been passed when none had. The bypass is now an offer-side fact.
 *
 * Failure mode: the audit write is best-effort. Losing the trail must not fail the offer the
 * recruiter explicitly acknowledged, so a write error is logged and swallowed.
 */
export async function recordOfferInterviewBypass(application, userId) {
  const { plain, candidateId, jobId } = applicationMeta(application);
  const applicationId = String(plain._id || plain.id || '');

  await writeAtsAudit(
    String(userId),
    {
      action: ActivityActions.OFFER_INTERVIEW_BYPASS,
      entityType: EntityTypes.JOB_APPLICATION,
      entityId: applicationId,
      metadata: {
        reason: 'no_selected_interview_round',
        related: {
          ...(candidateId && { candidateId }),
          ...(jobId && { jobId }),
        },
      },
    },
    null,
    { editContext: { staffEdit: true } }
  ).catch((err) => logger.warn('ats_audit offer.interviewBypass:', err?.message || err));
}
