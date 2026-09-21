import mongoose from 'mongoose';
import Meeting from '../models/meeting.model.js';
import TranscriptVersion from '../models/transcriptVersion.model.js';
import logger from '../config/logger.js';
import { isRedisEnabled } from '../config/redis.js';
import { buildTranscriptOwnerKey } from './transcriptAssembly.service.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import InterviewEvaluation from '../models/interviewEvaluation.model.js';
import { hasUsableScorecard, shouldEnqueueBiasCheck } from './interviewBias.inputs.js';
import {
  BIAS_ADVISORY_NOTICE,
  BIAS_MODEL,
  BIAS_PROMPT_VERSION,
  BIAS_SKIP_REASONS,
} from '../constants/interviewBias.js';
import { buildBiasJobId, getBiasQueue } from '../queues/biasQueue.js';

const MEETING_SELECT =
  'meetingId jobId jobPosition interviewScorecard interviewResult durationMinutes +biasCheck';

/**
 * @param {string} id
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function resolveMeetingForBias(id) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return null;
  if (
    mongoose.Types.ObjectId.isValid(trimmed) &&
    String(new mongoose.Types.ObjectId(trimmed)) === trimmed
  ) {
    const byId = await Meeting.findById(trimmed).select(MEETING_SELECT);
    if (byId) return byId;
  }
  return Meeting.findOne({ meetingId: trimmed }).select(MEETING_SELECT);
}

/**
 * @param {object} meeting
 * @returns {Promise<boolean>}
 */
export async function transcriptVersionExists(meeting) {
  const interviewId = meeting.id || meeting._id?.toString?.() || String(meeting._id);
  const ownerKey = buildTranscriptOwnerKey({ interviewId, meetingId: meeting.meetingId });
  const doc = await TranscriptVersion.findOne({ ownerKey }).select('_id').lean();
  if (doc) return true;
  const seg = await TranscriptSegment.exists({ meetingId: meeting.meetingId });
  return !!seg;
}

/**
 * @param {object} meeting
 * @returns {Promise<boolean>}
 */
async function meetingHasScorecard(meeting) {
  if (hasUsableScorecard(meeting.interviewScorecard)) return true;
  const ev = await InterviewEvaluation.findOne({
    meeting: meeting._id,
    $or: [{ comment: { $nin: [null, ''] } }, { 'ratings.rating': { $ne: null } }],
  })
    .select('_id')
    .lean();
  return !!ev;
}

/**
 * Stamp pending (or skipped when Redis is down) without touching interviewResult.
 * @param {import('mongoose').Types.ObjectId} mongoId
 * @param {object} biasCheck
 */
async function stampBiasCheck(mongoId, biasCheck) {
  await Meeting.updateOne({ _id: mongoId }, { $set: { biasCheck } });
}

/**
 * Enqueue a bias job. Background callers omit force so missing transcript/scorecard is a no-op.
 * Staff Re-run passes force: true.
 * @param {string} meetingIdOrMongoId
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ enqueued: boolean, reason?: string }>}
 */
export async function enqueueInterviewBiasCheck(meetingIdOrMongoId, options = {}) {
  const force = options.force === true;
  const meeting = await resolveMeetingForBias(meetingIdOrMongoId);
  if (!meeting) {
    return { enqueued: false, reason: 'meeting_not_found' };
  }
  const hasScorecard = await meetingHasScorecard(meeting);
  if (!force && !hasScorecard) {
    return { enqueued: false, reason: 'no_scorecard' };
  }
  if (!force) {
    const hasTranscript = await transcriptVersionExists(meeting);
    if (!shouldEnqueueBiasCheck({ hasScorecard, hasTranscript })) {
      return { enqueued: false, reason: 'no_transcript' };
    }
  }
  if (force && isRedisEnabled() && meeting.biasCheck?.status === 'pending') {
    return { enqueued: true, reason: 'already_pending' };
  }

  const pendingStamp = {
    status: 'pending',
    skipReason: '',
    flags: [],
    evidence: [],
    reasons: [],
    advisoryNotice: BIAS_ADVISORY_NOTICE,
    model: BIAS_MODEL,
    promptVersion: BIAS_PROMPT_VERSION,
    analyzedAt: null,
  };

  /**
   * Redis-off (local) or enqueue failure: run GPT inline so Re-run still produces a report.
   * @returns {Promise<{ enqueued: boolean, reason: string }>}
   */
  const runInline = async () => {
    const { analyzeInterviewBias } = await import('./interviewBias.service.js');
    await analyzeInterviewBias(meeting._id.toString());
    return { enqueued: true, reason: 'inline' };
  };

  if (!isRedisEnabled()) {
    try {
      return await runInline();
    } catch (err) {
      logger.warn('[interviewBias] inline analyze failed:', err?.message || err);
      await stampBiasCheck(meeting._id, {
        ...pendingStamp,
        status: 'failed',
        analyzedAt: new Date(),
        reasons: ['Automatic bias review failed. Try Re-run.'],
      });
      return { enqueued: false, reason: 'inline_failed' };
    }
  }

  await stampBiasCheck(meeting._id, pendingStamp);
  const meetingKey = meeting._id.toString();
  try {
    await getBiasQueue().add(
      'analyze',
      { meetingId: meetingKey, requestedAt: Date.now() },
      { jobId: buildBiasJobId(meetingKey) }
    );
    return { enqueued: true };
  } catch (err) {
    logger.warn('[interviewBias] enqueue failed, analyzing inline:', err?.message || err);
    try {
      return await runInline();
    } catch (inlineErr) {
      logger.warn('[interviewBias] inline analyze failed:', inlineErr?.message || inlineErr);
      await stampBiasCheck(meeting._id, {
        ...pendingStamp,
        status: 'skipped',
        skipReason: BIAS_SKIP_REASONS.queue_unavailable,
        analyzedAt: new Date(),
      });
      return { enqueued: false, reason: BIAS_SKIP_REASONS.queue_unavailable };
    }
  }
}
