import logger from '../config/logger.js';
import { runAllReconciliation } from './workforceReconciliation.js';

const DEFAULT_INTERVAL_HOURS = 24;

let intervalId = null;
let inflight = false;

export async function runWorkforceReconciliationTick() {
  if (inflight) {
    logger.info('[workforceReconciliation] previous run still in flight - skipping');
    return { skipped: true };
  }
  inflight = true;
  try {
    await runAllReconciliation();
    return { ok: true };
  } catch (err) {
    logger.warn(`[workforceReconciliation] failed: ${err.message}`);
    return { error: err.message };
  } finally {
    inflight = false;
  }
}

export function startWorkforceReconciliationScheduler({ intervalHours = DEFAULT_INTERVAL_HOURS } = {}) {
  if (intervalId) return;
  const ms = Math.max(1, Number(intervalHours)) * 60 * 60 * 1000;
  intervalId = setInterval(() => {
    runWorkforceReconciliationTick().catch((err) =>
      logger.warn(`[workforceReconciliation] tick error: ${err.message}`)
    );
  }, ms);
  intervalId.unref?.();
  logger.info(`[workforceReconciliation] scheduler started (every ${intervalHours}h)`);
}

export function stopWorkforceReconciliationScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[workforceReconciliation] scheduler stopped');
  }
}
