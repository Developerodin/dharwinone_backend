import logger from '../config/logger.js';
import { runReconciler } from './salesAgentCacheReconciler.job.js';

const DEFAULT_INTERVAL_HOURS = 24;

let intervalId = null;
let inflight = false;

export async function runSalesAgentCacheReconcilerTick() {
  if (inflight) {
    logger.info('[salesAgentCacheReconciler] previous run still in flight - skipping');
    return { skipped: true };
  }
  inflight = true;
  try {
    const result = await runReconciler();
    return { ok: true, ...result };
  } catch (err) {
    logger.warn(`[salesAgentCacheReconciler] failed: ${err.message}`);
    return { error: err.message };
  } finally {
    inflight = false;
  }
}

export function startSalesAgentCacheReconcilerScheduler({ intervalHours = DEFAULT_INTERVAL_HOURS } = {}) {
  if (intervalId) return;
  const ms = Math.max(1, Number(intervalHours)) * 60 * 60 * 1000;
  intervalId = setInterval(() => {
    runSalesAgentCacheReconcilerTick().catch((err) =>
      logger.warn(`[salesAgentCacheReconciler] tick error: ${err.message}`)
    );
  }, ms);
  intervalId.unref?.();
  logger.info(`[salesAgentCacheReconciler] scheduler started (every ${intervalHours}h)`);
}

export function stopSalesAgentCacheReconcilerScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[salesAgentCacheReconciler] scheduler stopped');
  }
}
