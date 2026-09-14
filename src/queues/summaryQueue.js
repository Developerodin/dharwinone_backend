import { Queue, QueueEvents } from 'bullmq';
import { isRedisEnabled, redisConnection } from '../config/redis.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

export const SUMMARY_QUEUE = 'summary.finalize';

export function summaryQueueOptions() {
  return {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7, count: 1000 },
      removeOnFail: false,
    },
  };
}

let queueSingleton = null;
let eventsSingleton = null;

export function getSummaryQueue() {
  if (!isRedisEnabled()) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Summary queue unavailable (Redis disabled)');
  }
  if (!queueSingleton) queueSingleton = new Queue(SUMMARY_QUEUE, summaryQueueOptions());
  return queueSingleton;
}

export function getSummaryQueueEvents() {
  if (!isRedisEnabled()) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Summary queue events unavailable (Redis disabled)');
  }
  if (!eventsSingleton) eventsSingleton = new QueueEvents(SUMMARY_QUEUE, { connection: redisConnection() });
  return eventsSingleton;
}

/** bullmq rejects custom job ids containing ':' (unless exactly 3 parts), so ids use '-' only. */
export function buildFinalizeJobId({ meetingId, recordingId, replayAt = null } = {}) {
  const base = `finalize-${String(recordingId || meetingId)}`;
  return (replayAt ? `${base}-replay-${replayAt}` : base).replace(/:/g, '_');
}

export async function enqueueFinalize({
  meetingId,
  recordingId,
  delayMs = 0,
  segmentShortfall = false,
  replayAt = null,
} = {}) {
  const q = getSummaryQueue();
  return q.add(
    'finalize',
    { meetingId, recordingId: recordingId ? String(recordingId) : null, requestedAt: Date.now(), segmentShortfall },
    {
      jobId: buildFinalizeJobId({ meetingId, recordingId, replayAt }),
      delay: Math.max(0, Number(delayMs) || 0),
    }
  );
}
