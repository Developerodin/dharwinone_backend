import * as meetingService from './meeting.service.js';
import {
  autoEndExpiredInternalMeetings,
  sendUpcomingInternalMeetingReminders,
} from './internalMeeting.service.js';
import { materializeDueSeries, sendDueOccurrenceInvites } from './meetingSeries.service.js';
import logger from '../config/logger.js';

const DEFAULT_INTERVAL_MINUTES = 5;

let intervalId = null;

const runAutoEndMeetings = async () => {
  try {
    const [count, internalCount] = await Promise.all([
      meetingService.autoEndExpiredMeetings(),
      autoEndExpiredInternalMeetings(),
    ]);
    const total = count + internalCount;
    if (total > 0) {
      logger.info(
        `[Meeting scheduler] Auto-ended ${count} interview(s) and ${internalCount} internal meeting(s) (${total} total)`
      );
    }
  } catch (err) {
    logger.error('[Meeting scheduler] Run failed:', err?.message || err);
  }
};

const runUpcomingMeetingReminders = async () => {
  try {
    const [stats] = await Promise.all([
      meetingService.sendUpcomingMeetingReminders(),
      sendUpcomingInternalMeetingReminders(),
    ]);
    if (stats && (stats.sent || stats.retried || stats.failed || stats.staleRecovered)) {
      logger.info(
        `[Meeting scheduler] T-15 pass — sent:${stats.sent} retried:${stats.retried} ` +
          `failed:${stats.failed} staleRecovered:${stats.staleRecovered}`
      );
    }
  } catch (err) {
    logger.error('[Meeting scheduler] Upcoming reminders failed:', err?.message || err);
  }
};

const runSeriesMaterialization = async () => {
  try {
    const { series, created } = await materializeDueSeries();
    const { sent } = await sendDueOccurrenceInvites();
    if (created > 0 || sent > 0) {
      logger.info(
        `[Meeting scheduler] Series — materialized ${created} occurrence(s) across ${series} series, sent ${sent} invite(s)`
      );
    }
  } catch (err) {
    logger.error('[Meeting scheduler] Series materialization failed:', err?.message || err);
  }
};

const runInterviewConclusionNotifications = async () => {
  try {
    const stats = await meetingService.sendInterviewConclusionNotifications();
    if (stats.sent || stats.retried || stats.failed || stats.staleRecovered) {
      logger.info(
        `[Meeting scheduler] Conclusion pass — sent:${stats.sent} retried:${stats.retried} ` +
          `failed:${stats.failed} staleRecovered:${stats.staleRecovered}`
      );
    }
  } catch (err) {
    logger.error('[Meeting scheduler] Conclusion notifications failed:', err?.message || err);
  }
};

export const startMeetingScheduler = () => {
  if (intervalId) return;
  const intervalMinutes = Math.max(1, Number(process.env.MEETING_SCHEDULER_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES);
  const intervalMs = intervalMinutes * 60 * 1000;
  runSeriesMaterialization();
  runAutoEndMeetings();
  runUpcomingMeetingReminders();
  runInterviewConclusionNotifications();
  intervalId = setInterval(() => {
    runSeriesMaterialization();
    runAutoEndMeetings();
    runUpcomingMeetingReminders();
    runInterviewConclusionNotifications();
  }, intervalMs);
  logger.info(`[Meeting scheduler] Started (interval: ${intervalMinutes} min)`);
};

export const stopMeetingScheduler = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Meeting scheduler] Stopped');
  }
};
