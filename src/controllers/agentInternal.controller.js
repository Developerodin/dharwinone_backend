import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import Recording from '../models/recording.model.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

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
    { meetingId, aiProcessingStatus: 'dispatching' },
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
    utterances: Array.isArray(s.utterances) ? s.utterances : [],
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
