import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import Recording from '../models/recording.model.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { appendPartials } from '../services/partialTranscript.service.js';
import { enqueueFinalize } from '../queues/summaryQueue.js';
import { registerRunBody, transcriptBatchBody, finalizeV2BodySchema } from '../validations/agentInternal.validation.js';
import validate from '../middlewares/validate.js';
import {
  registerRun,
  ingestTranscriptBatch,
  heartbeatV2,
  finalizeV2Run,
} from '../services/agentInternalV2.service.js';

const FINALIZE_GRACE_MS = 5000;

/** Delay so trailing segment writes land before the summary job runs. Finalize never refuses to enqueue (B2). */
export function computeFinalizeDelayMs(lastSegmentSentAt, now = Date.now(), graceMs = FINALIZE_GRACE_MS) {
  if (lastSegmentSentAt == null) return 0;
  const lastMs = new Date(lastSegmentSentAt).getTime();
  if (!Number.isFinite(lastMs)) return 0;
  return Math.min(graceMs, Math.max(0, graceMs - (now - lastMs)));
}

const SPEAKER_SOURCES = new Set(['livekit', 'deepgram', 'fallback']);

/** Maps a v1 agent utterance onto the TranscriptSegment utterance schema (B3). Returns schema keys only. */
export function normalizeV1Utterance(u) {
  const speakerSource = SPEAKER_SOURCES.has(u?.speakerSource) ? u.speakerSource : 'livekit';
  return {
    speaker: u.speaker ?? u.participantIdentity ?? null,
    speakerName: u.speakerName ?? u.displayName ?? null,
    speakerLabel: u.speakerLabel ?? null,
    speakerSource,
    speakerConfidence: u.speakerConfidence ?? null,
    text: u.text,
    startMs: u.startMs,
    endMs: u.endMs,
    confidence: u.confidence ?? null,
  };
}

/** POST /v1/internal/meetings/:meetingId/agent-joined */
export const agentJoined = catchAsync(async (req, res) => {
  const { meetingId } = req.params;
  const { roomSid, participantCount } = req.body || {};

  const dispatch = await AgentDispatch.findOneAndUpdate(
    { _id: req.agentDispatch.id, status: 'requested' },
    { $set: { status: 'running', joinedAt: new Date(), lastHeartbeat: new Date() } },
    { new: true }
  );
  if (!dispatch) {
    return res.status(httpStatus.CONFLICT).json({ message: 'dispatch already advanced' });
  }

  await Recording.findOneAndUpdate(
    {
      ...(req.agentDispatch.recordingId ? { _id: req.agentDispatch.recordingId } : { meetingId }),
      aiProcessingStatus: 'dispatching',
    },
    { $set: { aiProcessingStatus: 'transcribing' } }
  );

  logger.info('[AgentInternal] agent-joined', { meetingId, roomSid, participantCount });
  return res.status(httpStatus.OK).json({ status: 'ok' });
});

export function validateSegmentBatch(segments, limit = config.ai.segmentBatchLimit) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, reason: 'segments must be a non-empty array' };
  }
  if (segments.length > limit) {
    return { ok: false, reason: `too many segments in one batch (max ${limit})` };
  }
  for (const s of segments) {
    if (
      typeof s.sequenceNumber !== 'number' ||
      typeof s.windowStartMs !== 'number' ||
      typeof s.windowEndMs !== 'number' ||
      typeof s.combinedText !== 'string'
    ) {
      return { ok: false, reason: 'segment missing required fields' };
    }
  }
  return { ok: true };
}

/** POST /v1/internal/meetings/:meetingId/transcript-segments */
export const transcriptSegments = catchAsync(async (req, res) => {
  const { meetingId } = req.params;
  const segments = req.body?.segments;
  const v = validateSegmentBatch(segments);
  if (!v.ok) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: v.reason });
  }

  const docs = segments.map((s) => ({
    meetingId,
    recordingId: req.agentDispatch.recordingId,
    sequenceNumber: s.sequenceNumber,
    windowStartMs: s.windowStartMs,
    windowEndMs: s.windowEndMs,
    combinedText: s.combinedText,
    utterances: Array.isArray(s.utterances) ? s.utterances.map(normalizeV1Utterance) : [],
    utteranceCount: Array.isArray(s.utterances) ? s.utterances.length : 0,
  }));

  let inserted = 0;
  let skipped = 0;
  try {
    const result = await TranscriptSegment.insertMany(docs, { ordered: false });
    inserted = result.length;
  } catch (err) {
    if (err?.code === 11000 || err?.writeErrors?.length) {
      inserted = err.insertedDocs?.length || 0;
      skipped = docs.length - inserted;
    } else {
      throw err;
    }
  }

  await AgentDispatch.findByIdAndUpdate(req.agentDispatch.id, {
    $set: { lastSegmentSentAt: new Date(), lastHeartbeat: new Date() },
  });

  return res.status(httpStatus.OK).json({ inserted, skipped });
});

/** POST /v1/internal/meetings/:meetingId/partial-transcripts */
export const partialTranscripts = catchAsync(async (req, res) => {
  const { meetingId } = req.params;
  const partials = Array.isArray(req.body?.partials) ? req.body.partials : [];
  const out = await appendPartials(meetingId, partials);
  return res.status(httpStatus.OK).json(out);
});

/** POST /v1/internal/meetings/:meetingId/runs */
export const runs = catchAsync(async (req, res) => {
  if (req.body.runId !== req.agentRunId) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'invalid_body' });
  }
  const out = await registerRun({
    dispatch: req.agentDispatch,
    runId: req.body.runId,
    body: req.body,
  });
  return res.status(httpStatus.OK).json(out);
});

/** POST /v1/internal/meetings/:meetingId/transcript-batches */
export const transcriptBatches = catchAsync(async (req, res) => {
  if (req.body.runId !== req.agentRunId) {
    return res.status(httpStatus.BAD_REQUEST).json({ message: 'invalid_body' });
  }
  const result = await ingestTranscriptBatch({
    dispatch: req.agentDispatch,
    runId: req.body.runId,
    batchSeq: req.body.batchSeq,
    utterances: req.body.utterances,
  });
  return res.status(result.status).json(result.body);
});

/** POST /v1/internal/meetings/:meetingId/heartbeat */
export const heartbeat = catchAsync(async (req, res) => {
  if (req.agentRunId) {
    await heartbeatV2({ dispatch: req.agentDispatch, runId: req.agentRunId });
    return res.status(httpStatus.OK).json({ status: 'ok' });
  }
  await AgentDispatch.findByIdAndUpdate(req.agentDispatch.id, {
    $set: { lastHeartbeat: new Date() },
  });
  return res.status(httpStatus.OK).json({ status: 'ok' });
});

/** POST /v1/internal/meetings/:meetingId/finalize */
export const finalize = catchAsync(async (req, res) => {
  if (req.agentRunId) {
    const { error, value } = finalizeV2BodySchema.validate(req.body || {}, { abortEarly: false });
    if (error) {
      return res.status(httpStatus.BAD_REQUEST).json({ message: 'invalid_body' });
    }
    if (value.runId !== req.agentRunId) {
      return res.status(httpStatus.BAD_REQUEST).json({ message: 'invalid_body' });
    }
    const result = await finalizeV2Run({ dispatch: req.agentDispatch, body: value });
    return res.status(result.status).json(result.body);
  }

  const { meetingId } = req.params;
  const { totalSegments, durationMs } = req.body || {};
  const { recordingId } = req.agentDispatch;

  const dispatch = await AgentDispatch.findById(req.agentDispatch.id);
  const delayMs = computeFinalizeDelayMs(dispatch?.lastSegmentSentAt);

  const have = await TranscriptSegment.countDocuments(
    recordingId ? { meetingId, recordingId } : { meetingId }
  );
  const segmentShortfall = typeof totalSegments === 'number' && have < totalSegments;
  if (segmentShortfall) {
    logger.warn('[AgentInternal] finalize segment shortfall', {
      meetingId,
      recordingId,
      expected: totalSegments,
      have,
    });
  }

  const job = await enqueueFinalize({ meetingId, recordingId, delayMs, segmentShortfall });
  // If Redis is down, enqueue throws → agent gets 5xx and retries while dispatch stays active; bullmq dedupes by job id.
  await AgentDispatch.findByIdAndUpdate(req.agentDispatch.id, {
    $set: { status: 'completed', leftAt: new Date() },
  });

  return res.status(httpStatus.ACCEPTED).json({ status: 'queued', jobId: job.id, delayMs, durationMs });
});

export const runsValidation = validate(registerRunBody);
export const transcriptBatchesValidation = validate(transcriptBatchBody);
