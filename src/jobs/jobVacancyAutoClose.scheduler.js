import logger from '../config/logger.js';
import { runVacancyAutoCloseTick } from '../services/job.service.js';

const DEFAULT_INTERVAL_HOURS = 6;

let intervalId = null;
let inflight = false;

export async function runJobVacancyAutoCloseTick() {
  if (inflight) {
    logger.info('[vacancyAutoClose] previous run still in flight - skipping');
    return { skipped: true };
  }
  inflight = true;
  try {
    return await runVacancyAutoCloseTick();
  } catch (err) {
    logger.warn(`[vacancyAutoClose] failed: ${err.message}`);
    return { error: err.message };
  } finally {
    inflight = false;
  }
}

export function startVacancyAutoCloseScheduler({ intervalHours = DEFAULT_INTERVAL_HOURS } = {}) {
  if (intervalId) return;
  const ms = Math.max(1, Number(intervalHours)) * 60 * 60 * 1000;
  runJobVacancyAutoCloseTick().catch((err) =>
    logger.warn(`[vacancyAutoClose] initial tick error: ${err.message}`)
  );
  intervalId = setInterval(() => {
    runJobVacancyAutoCloseTick().catch((err) => logger.warn(`[vacancyAutoClose] tick error: ${err.message}`));
  }, ms);
  intervalId.unref?.();
  logger.info(`[vacancyAutoClose] scheduler started (every ${intervalHours}h)`);
}

export function stopVacancyAutoCloseScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[vacancyAutoClose] scheduler stopped');
  }
}
