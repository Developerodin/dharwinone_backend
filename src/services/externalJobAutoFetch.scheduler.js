/**
 * External Jobs auto-fetch scheduler. Same start-/stop-Scheduler + setInterval
 * pattern as every other scheduler in this codebase (see callRecordSync.scheduler.js).
 *
 * Deliberately NOT a per-config interval: this is one fixed-cadence poller
 * (every POLL_INTERVAL_MINUTES) that checks, on each tick, whether the single
 * config is enabled and whether its own `frequencyMinutes` has elapsed since
 * `lastRunAt`. Editing the config's frequency just changes what the next tick's
 * check compares against -- no interval is ever recreated, so there's no risk
 * of duplicate intervals stacking up across config saves/reloads.
 */
import ExternalJobAutoFetchConfig from '../models/externalJobAutoFetchConfig.model.js';
import { runAutoFetchSync } from './externalJobAutoFetch.service.js';
import logger from '../config/logger.js';

const POLL_INTERVAL_MINUTES = 5;

let running = false;

export async function tickAutoFetchScheduler() {
  if (running) return; // a run from a previous tick is still in flight (rate-limit throttling makes this real)
  running = true;
  try {
    const config = await ExternalJobAutoFetchConfig.findOne().sort({ createdAt: 1 }).lean();
    if (!config || !config.enabled) return;

    const dueAt = config.lastRunAt
      ? new Date(config.lastRunAt).getTime() + config.frequencyMinutes * 60 * 1000
      : 0;
    if (Date.now() < dueAt) return;

    const fullConfig = await ExternalJobAutoFetchConfig.findById(config._id);
    const result = await runAutoFetchSync(fullConfig, 'scheduled');
    logger.info(
      `[auto-fetch cron] status=${result.status} fetched=${result.stats.fetched} created=${result.stats.created} ` +
        `updated=${result.stats.updated} staleArchived=${result.stats.staleArchived} queriesFailed=${result.stats.queriesFailed}`
    );
  } catch (err) {
    logger.error(`[auto-fetch cron] tick failed: ${err.message}`);
  } finally {
    running = false;
  }
}

export function startExternalJobAutoFetchScheduler() {
  const intervalMs = POLL_INTERVAL_MINUTES * 60 * 1000;
  tickAutoFetchScheduler();
  const id = setInterval(tickAutoFetchScheduler, intervalMs);
  logger.info(`[auto-fetch cron] scheduler started (poll every ${POLL_INTERVAL_MINUTES} min)`);
  return id;
}

export function stopExternalJobAutoFetchScheduler(id) {
  if (id) {
    clearInterval(id);
    logger.info('[auto-fetch cron] scheduler stopped');
    return true;
  }
  return false;
}
