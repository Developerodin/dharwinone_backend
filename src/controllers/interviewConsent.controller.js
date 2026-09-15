import catchAsync from '../utils/catchAsync.js';
import * as interviewConsentService from '../services/interviewConsent.service.js';
import { writeAtsAudit } from '../services/atsAudit.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const recordConsent = catchAsync(async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return res.status(401).send({ message: 'Bearer token required' });
  }
  const result = await interviewConsentService.recordParticipantConsent({
    roomName: req.params.roomName,
    token,
    noticeVersion: req.body.noticeVersion,
    recording: req.body.recording,
    transcription: req.body.transcription,
    aiEvaluation: req.body.aiEvaluation,
  });
  // ponytail: ActivityLog.actor must be a User; public participants have none, so the meeting creator
  // owns the row and the participant is named in metadata. Add a participant actor type if audits need it.
  await writeAtsAudit(
    result.auditActorId,
    {
      action: ActivityActions.INTERVIEW_CONSENT_RECORDED,
      entityType: EntityTypes.MEETING,
      entityId: result.meetingId,
      metadata: {
        participantIdentity: result.identity,
        participantRole: result.consent.role ?? null,
        noticeVersion: result.noticeVersion,
        recording: result.consent.recording,
        transcription: result.consent.transcription,
        aiEvaluation: result.consent.aiEvaluation,
        replay: result.replay,
      },
    },
    req
  );
  res.status(result.replay ? 200 : 201).send({
    meetingId: result.meetingId,
    identity: result.identity,
    noticeVersion: result.noticeVersion,
    recording: result.consent.recording,
    transcription: result.consent.transcription,
    aiEvaluation: result.consent.aiEvaluation,
    acceptedAt: result.consent.acceptedAt,
  });
});

export { recordConsent };
