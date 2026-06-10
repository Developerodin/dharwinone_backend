import { getSummaryQueue } from '../queues/summaryQueue.js';
import { writeDeadLetter } from '../queues/deadLetter.service.js';
import logger from '../config/logger.js';
import { isRedisEnabled } from '../config/redis.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

export async function sweepStuckFinalize() {
  if (!isRedisEnabled()) return;
  const q = getSummaryQueue();
  const active = await q.getActive(0, 100);
  for (const job of active) {
    const startedAt = job.processedOn || job.timestamp;
    if (Date.now() - startedAt > STUCK_THRESHOLD_MS) {
      logger.warn('[StuckFinalizeSweeper] active job stuck > 10m', {
        jobId: job.id,
        age: Date.now() - startedAt,
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        await job.moveToFailed(new Error('finalize stuck > 10 minutes'), 'manual-sweep');
        // eslint-disable-next-line no-await-in-loop
        await writeDeadLetter(job, new Error('finalize stuck > 10 minutes'));
      } catch (err) {
        logger.warn('[StuckFinalizeSweeper] failed to move job', { error: err.message });
      }
    }
  }
}

let intervalHandle = null;
export function startStuckFinalizeSweeper() {
  if (!isRedisEnabled()) {
    logger.warn('[StuckFinalizeSweeper] Redis disabled; sweeper not started');
    return;
  }
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    sweepStuckFinalize().catch((err) =>
      logger.error('[StuckFinalizeSweeper] error', { error: err.message })
    );
  }, SWEEP_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopStuckFinalizeSweeper() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
