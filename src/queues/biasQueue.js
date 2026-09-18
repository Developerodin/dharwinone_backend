import { Queue, QueueEvents } from 'bullmq';
import { isRedisEnabled, redisConnection } from '../config/redis.js';
import { sanitizeBiasJobMeetingKey } from '../services/interviewBias.inputs.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

export const BIAS_QUEUE = 'interview.bias';

/**
 * BullMQ options — same retention/backoff as the summary queue.
 * @returns {object}
 */
export function biasQueueOptions() {
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

/**
 * @returns {import('bullmq').Queue}
 */
export function getBiasQueue() {
  if (!isRedisEnabled()) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Bias queue unavailable (Redis disabled)');
  }
  if (!queueSingleton) queueSingleton = new Queue(BIAS_QUEUE, biasQueueOptions());
  return queueSingleton;
}

/**
 * @returns {import('bullmq').QueueEvents}
 */
export function getBiasQueueEvents() {
  if (!isRedisEnabled()) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Bias queue events unavailable (Redis disabled)');
  }
  if (!eventsSingleton) eventsSingleton = new QueueEvents(BIAS_QUEUE, { connection: redisConnection() });
  return eventsSingleton;
}

/**
 * Unique job id per enqueue so a scorecard overwrite always starts a new run.
 * @param {string} meetingId
 * @returns {string}
 */
export function buildBiasJobId(meetingId) {
  const safe = sanitizeBiasJobMeetingKey(meetingId);
  return `bias-${safe}-${Date.now()}`;
}
