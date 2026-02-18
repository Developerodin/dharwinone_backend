import attendanceService from './attendance.service.js';
import logger from '../config/logger.js';

const DEFAULT_DURATION_HOURS = 12;
const DEFAULT_INTERVAL_MINUTES = 15;

let intervalId = null;

const runAutoPunchOut = async () => {
  try {
    const durationHours = Number(process.env.ATTENDANCE_AUTO_PUNCH_OUT_DURATION_HOURS) || DEFAULT_DURATION_HOURS;
    const activeList = await attendanceService.findAllActivePunchIns();
    for (const record of activeList) {
      try {
        const updated = await attendanceService.autoPunchOut(record, durationHours);
        if (updated) {
          logger.info(`Attendance auto punch-out: record ${record._id} (student ${record.student})`);
        }
      } catch (err) {
        logger.error(`Attendance auto punch-out failed for record ${record._id}:`, err.message);
      }
    }
  } catch (err) {
    logger.error('Attendance scheduler run failed:', err.message);
  }
};

export const startAttendanceScheduler = () => {
  if (intervalId) return;
  const intervalMinutes = Math.max(1, Number(process.env.ATTENDANCE_SCHEDULER_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES);
  const intervalMs = intervalMinutes * 60 * 1000;
  runAutoPunchOut();
  intervalId = setInterval(runAutoPunchOut, intervalMs);
  logger.info(`Attendance scheduler started (interval: ${intervalMinutes} minutes)`);
};

export const stopAttendanceScheduler = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Attendance scheduler stopped');
  }
};
