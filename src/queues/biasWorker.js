import { Worker } from 'bullmq';
import { BIAS_QUEUE } from './biasQueue.js';
import { analyzeInterviewBias, markBiasCheckFailed } from '../services/interviewBias.service.js';
import { writeDeadLetter } from './deadLetter.service.js';
import { isRedisEnabled, redisConnection } from '../config/redis.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

let workerSingleton = null;

/**
 * Start the interview-bias BullMQ worker (no-op when Redis is disabled).
 * @returns {import('bullmq').Worker|null}
 */
export function startBiasWorker() {
  if (!isRedisEnabled()) {
    logger.warn('[BiasWorker] Redis disabled; worker not started');
    return null;
  }
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(
    BIAS_QUEUE,
    async (job) => {
      logger.info('[BiasWorker] processing', { jobId: job.id, attempt: job.attemptsMade + 1 });
      return analyzeInterviewBias(job.data.meetingId);
    },
    {
      connection: redisConnection(),
      concurrency: config.ai.workerConcurrency,
      lockDuration: config.ai.finalizeTimeoutMs + 30000,
    }
  );

  workerSingleton.on('failed', async (job, err) => {
    logger.error('[BiasWorker] job failed', {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
    });
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
      await writeDeadLetter(job, err);
      const meetingId = job.data?.meetingId;
      if (meetingId) {
        await markBiasCheckFailed(meetingId).catch((stampErr) => {
          logger.warn('[BiasWorker] markBiasCheckFailed failed:', stampErr?.message || stampErr);
        });
      }
    }
  });

  workerSingleton.on('completed', (job, result) => {
    logger.info('[BiasWorker] job completed', { jobId: job.id, result });
  });

  return workerSingleton;
}

/**
 * Stop the bias worker if it was started.
 * @returns {Promise<void>}
 */
export async function stopBiasWorker() {
  if (workerSingleton) {
    await workerSingleton.close();
    workerSingleton = null;
  }
}
