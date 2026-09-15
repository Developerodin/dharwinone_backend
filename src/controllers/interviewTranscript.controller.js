import catchAsync from '../utils/catchAsync.js';
import * as interviewTranscriptService from '../services/interviewTranscript.service.js';
import { writeDedupedInterviewViewAudit } from '../utils/interviewViewAuditDedup.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const auditActorId = (req) => String(req.user?.id || req.user?._id || '');

const auditMetadataForMeeting = (payload) => ({
  interviewId: payload.interviewId,
  meetingId: payload.meetingId,
  transcriptVersion: payload.version,
});

const getTranscript = catchAsync(async (req, res) => {
  const payload = await interviewTranscriptService.getInterviewTranscript(req.params.id, req.user, req.query);
  await writeDedupedInterviewViewAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_TRANSCRIPT_VIEW,
      entityType: EntityTypes.TRANSCRIPT_VERSION,
      entityId: payload.transcriptVersionId,
      metadata: auditMetadataForMeeting(payload),
    },
    req
  );
  const responseBody = { ...payload };
  delete responseBody.transcriptVersionId;
  res.send(responseBody);
});

const getTranscriptUtteranceContext = catchAsync(async (req, res) => {
  const payload = await interviewTranscriptService.getInterviewTranscriptUtteranceContext(
    req.params.id,
    req.params.utteranceId,
    req.user,
    req.query
  );
  await writeDedupedInterviewViewAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_TRANSCRIPT_VIEW,
      entityType: EntityTypes.TRANSCRIPT_VERSION,
      entityId: payload.transcriptVersionId,
      metadata: {
        ...auditMetadataForMeeting(payload),
        utteranceId: payload.utteranceId,
        context: true,
      },
    },
    req
  );
  res.send(payload);
});

const getSummary = catchAsync(async (req, res) => {
  const payload = await interviewTranscriptService.getInterviewSummary(req.params.id, req.user, req.query);
  await writeDedupedInterviewViewAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_SUMMARY_VIEW,
      entityType: EntityTypes.SUMMARY,
      entityId: payload.summaryId,
      metadata: {
        interviewId: payload.interviewId,
        meetingId: payload.meetingId,
        evaluationVersion: payload.version,
      },
    },
    req
  );
  const responseBody = { ...payload };
  delete responseBody.summaryId;
  res.send(responseBody);
});

export { getTranscript, getTranscriptUtteranceContext, getSummary };
