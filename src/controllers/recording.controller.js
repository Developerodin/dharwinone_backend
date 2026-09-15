import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import recordingService from '../services/recording.service.js';
import { writeDedupedInterviewViewAudit } from '../utils/interviewViewAuditDedup.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const auditActorId = (req) => String(req.user?.id || req.user?._id || '');

const listAll = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'limit', 'status', 'q', 'dateFrom', 'dateTo', 'source']);
  const result = await recordingService.listAll(options, req.user);
  for (const row of result.results || []) {
    if (!row.playbackUrl) continue;
    await writeDedupedInterviewViewAudit(
      auditActorId(req),
      {
        action: ActivityActions.INTERVIEW_RECORDING_VIEW,
        entityType: EntityTypes.RECORDING,
        entityId: String(row.id || row._id),
        metadata: { meetingId: row.meetingId ?? null, source: 'recordings.list' },
      },
      req
    );
  }
  res.send(result);
});

/**
 * Sync recordings from LiveKit egress: pulls every egress LiveKit knows about
 * and upserts our DB so each row reflects the real LiveKit status. Idempotent.
 */
const syncFromLiveKit = catchAsync(async (req, res) => {
  const result = await recordingService.syncFromLiveKit();
  res.send(result);
});

/**
 * GET /recordings/:recordingId/transcript — return all transcript segments for
 * a recording (ordered by sequenceNumber). Empty `segments[]` if none ingested.
 */
const getTranscript = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'limit']);
  const result = await recordingService.getTranscriptByRecordingId(req.params.recordingId, req.user, options);
  const recordingId = result.recording?.id || req.params.recordingId;
  await writeDedupedInterviewViewAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_TRANSCRIPT_VIEW,
      entityType: EntityTypes.RECORDING,
      entityId: String(recordingId),
      metadata: {
        meetingId: result.recording?.meetingId ?? null,
        source: 'recordings.transcript',
        transcriptVersion: result.transcriptVersion ?? null,
      },
    },
    req
  );
  res.send(result);
});

export { listAll, syncFromLiveKit, getTranscript };
