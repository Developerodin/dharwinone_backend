import * as meetingService from './meeting.service.js';
import logger from '../config/logger.js';

const DEFAULT_INTERVAL_MINUTES = 5;

let intervalId = null;

const runAutoEndMeetings = async () => {
  try {
    const count = await meetingService.autoEndExpiredMeetings();
    if (count > 0) {
      logger.info(`[Meeting scheduler] Auto-ended ${count} expired meeting(s)`);
    }
  } catch (err) {
    logger.error('[Meeting scheduler] Run failed:', err?.message || err);
  }
};

export const startMeetingScheduler = () => {
  if (intervalId) return;
  const intervalMinutes = Math.max(1, Number(process.env.MEETING_SCHEDULER_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES);
  const intervalMs = intervalMinutes * 60 * 1000;
  runAutoEndMeetings();
  intervalId = setInterval(runAutoEndMeetings, intervalMs);
  logger.info(`[Meeting scheduler] Started (interval: ${intervalMinutes} min)`);
};

export const stopMeetingScheduler = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Meeting scheduler] Stopped');
  }
};
