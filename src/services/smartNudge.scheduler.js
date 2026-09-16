import config from '../config/config.js';
import logger from '../config/logger.js';
import { runSmartNudgeTick } from './smartNudge.service.js';

const DEFAULT_INTERVAL_MINUTES = 15;

let intervalId = null;
let tickRunning = false;

/**
 * One scheduler pass. Skip if a previous tick is still running.
 * @returns {Promise<void>}
 */
export const runSmartNudgePass = async () => {
  if (!config.smartNudge?.enabled) return;
  if (tickRunning) {
    logger.warn('[smartNudge] tick skipped: previous still running');
    return;
  }
  tickRunning = true;
  try {
    const stats = await runSmartNudgeTick();
    if (stats.scanned || stats.sent) {
      logger.info(
        `[smartNudge] tick scanned=${stats.scanned} sent=${stats.sent} skipped=${stats.skipped}`
      );
    }
  } catch (err) {
    logger.error(`[smartNudge] tick failed: ${err?.message || err}`);
  } finally {
    tickRunning = false;
  }
};

/**
 * Start the 15-minute (configurable) smart nudge scheduler.
 * @returns {void}
 */
export const startSmartNudgeScheduler = () => {
  if (intervalId) return;
  if (!config.smartNudge?.enabled) {
    logger.info('[smartNudge] scheduler off (SMART_NUDGES_ENABLED)');
    return;
  }
  const intervalMinutes = Math.max(5, Number(config.smartNudge.intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  runSmartNudgePass();
  intervalId = setInterval(runSmartNudgePass, intervalMinutes * 60 * 1000);
  logger.info(`[smartNudge] Started (interval: ${intervalMinutes} min)`);
};

/**
 * Stop the smart nudge scheduler.
 * @returns {void}
 */
export const stopSmartNudgeScheduler = () => {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
  logger.info('[smartNudge] Stopped');
};
