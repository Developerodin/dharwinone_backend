import { Worker } from 'bullmq';
import { SUMMARY_QUEUE } from './summaryQueue.js';
import { finalizeSummary } from '../services/summaryFinalize.service.js';
import { writeDeadLetter } from './deadLetter.service.js';
import { isRedisEnabled, redisConnection } from '../config/redis.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

let workerSingleton = null;

export function startSummaryWorker() {
  if (!isRedisEnabled()) {
    logger.warn('[SummaryWorker] Redis disabled; worker not started');
    return null;
  }
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(
    SUMMARY_QUEUE,
    async (job) => {
      logger.info('[SummaryWorker] processing', { jobId: job.id, attempt: job.attemptsMade + 1 });
      const result = await Promise.race([
        finalizeSummary(job.data),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('finalize timeout')), config.ai.finalizeTimeoutMs)
        ),
      ]);
      return result;
    },
    {
      connection: redisConnection(),
      concurrency: config.ai.workerConcurrency,
      lockDuration: config.ai.finalizeTimeoutMs + 30000,
    }
  );

  workerSingleton.on('failed', async (job, err) => {
    logger.error('[SummaryWorker] job failed', {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
    });
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
      await writeDeadLetter(job, err);
    }
  });

  workerSingleton.on('completed', (job, result) => {
    logger.info('[SummaryWorker] job completed', { jobId: job.id, result });
  });

  return workerSingleton;
}

export async function stopSummaryWorker() {
  if (workerSingleton) {
    await workerSingleton.close();
    workerSingleton = null;
  }
}
