import logger from '../config/logger.js';
import { uniqueEvents } from './smartNudge.helpers.js';
import {
  detectInterviewNoShows,
  detectResultOverdue,
  detectApplicationStale,
  detectSelectedNoOffer,
  detectOfferAging,
} from './smartNudge.detectorAts.js';
import {
  detectJoiningOverdue,
  detectPreboardIncomplete,
  detectTaskOverdue,
  detectLeavePendingStale,
} from './smartNudge.detectorOps.js';

/**
 * Run every v1 detector. Failures in one scanner must not abort the tick.
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<object[]>}
 */
export const runAllDetectors = async ({ now = new Date() } = {}) => {
  const scanners = [
    ['interview_no_show', () => detectInterviewNoShows({ now })],
    ['result_overdue', () => detectResultOverdue({ now })],
    ['application_stale', () => detectApplicationStale({ now })],
    ['selected_no_offer', () => detectSelectedNoOffer({ now })],
    ['offer_aging', () => detectOfferAging({ now })],
    ['joining_overdue', () => detectJoiningOverdue({ now })],
    ['preboard_incomplete', () => detectPreboardIncomplete({ now })],
    ['task_overdue', () => detectTaskOverdue({ now })],
    ['leave_pending_stale', () => detectLeavePendingStale({ now })],
  ];
  const batches = await Promise.all(
    scanners.map(async ([name, fn]) => {
      try {
        return await fn();
      } catch (err) {
        logger.warn(`[smartNudge] detector ${name} failed: ${err?.message || err}`);
        return [];
      }
    })
  );
  return uniqueEvents(batches.flat());
};

export {
  detectInterviewNoShows,
  detectResultOverdue,
  detectApplicationStale,
  detectSelectedNoOffer,
  detectOfferAging,
  detectJoiningOverdue,
  detectPreboardIncomplete,
  detectTaskOverdue,
  detectLeavePendingStale,
};
