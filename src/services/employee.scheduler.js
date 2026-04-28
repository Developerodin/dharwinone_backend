import Employee from '../models/employee.model.js';
import logger from '../config/logger.js';
import { runJoiningDateReminders } from './placementReminders.service.js';

/**
 * Auto deactivate candidates whose resign date has arrived.
 * Notifies candidate (by email) and admin (in-app) when deactivated.
 * @returns {Promise<number>} Number of candidates deactivated
 */

const autoDeactivateResignedCandidates = async () => {
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const candidatesToDeactivate = await Employee.find({
      resignDate: { $lte: now },
      isActive: true,
    })
      .select('_id fullName email resignDate adminId')
      .lean();

    if (!candidatesToDeactivate.length) return 0;

    const { notify, notifyByEmail } = await import('./notification.service.js');
    let deactivated = 0;
    for (const c of candidatesToDeactivate) {
      try {
        await Employee.updateOne({ _id: c._id }, { isActive: false });
        deactivated++;
        logger.info(
          `Auto-deactivated candidate ${c.fullName} (ID: ${c._id}, Email: ${c.email}) on resign date: ${c.resignDate?.toISOString?.() || c.resignDate}`
        );
        const title = 'Candidate auto-deactivated';
        const message = `${c.fullName || c.email || 'Candidate'} was auto-deactivated on resign date.`;
        const link = `/candidates/${c._id}`;
        if (c.adminId) {
          notify(c.adminId, { type: 'account', title, message, link }).catch(() => {});
        }
        if (c.email) {
          notifyByEmail(c.email, { type: 'account', title, message, link }).catch(() => {});
        }
      } catch (e) {
        logger.error(`Error auto-deactivating candidate ${c._id} (${c.email}): ${e.message}`);
      }
    }

    if (deactivated > 0) {
      logger.info(`Auto-deactivated ${deactivated} candidate(s) whose resign date has arrived`);
    }

    return deactivated;
  } catch (e) {
    logger.error(`autoDeactivateResignedCandidates failed: ${e.message}`);
    return 0;
  }
};

/**
 * Send joining date reminders for candidates whose joining date is in 3 days.
 * Notifies admin (in-app) and candidate (by email).
 */
const sendJoiningDateReminders = async () => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const inThreeDays = new Date(today);
    inThreeDays.setDate(inThreeDays.getDate() + 3);
    const nextDay = new Date(inThreeDays);
    nextDay.setDate(nextDay.getDate() + 1);

    const candidates = await Employee.find({
      joiningDate: { $gte: inThreeDays, $lt: nextDay },
      isActive: true,
    })
      .select('_id fullName email adminId')
      .lean();

    if (!candidates.length) return;

    const { notify, notifyByEmail } = await import('./notification.service.js');
    for (const c of candidates) {
      const name = c.fullName || c.email || 'Candidate';
      const title = 'Joining date reminder';
      const message = `Reminder: ${name}'s joining date is in 3 days.`;
      const link = `/candidates/${c._id}`;
      if (c.adminId) {
        notify(c.adminId, { type: 'account', title, message, link }).catch(() => {});
      }
      if (c.email) {
        notifyByEmail(c.email, { type: 'account', title, message, link }).catch(() => {});
      }
    }
  } catch (e) {
    logger.error(`sendJoiningDateReminders failed: ${e.message}`);
  }
};

/**
 * @param {number} intervalMinutes Default 60
 * @returns {NodeJS.Timeout}
 */
const startCandidateScheduler = (intervalMinutes = 60) => {
  const intervalMs = intervalMinutes * 60 * 1000;
  const run = async () => {
    await autoDeactivateResignedCandidates();
    await sendJoiningDateReminders();
    await runJoiningDateReminders().catch((e) => logger.error(`runJoiningDateReminders: ${e.message}`));
    try {
      const { runJoinedOnboardingJoiningReminders } = await import('./onboardingJoiningNotifications.service.js');
      const ob = await runJoinedOnboardingJoiningReminders();
      if (ob && (ob.t1 > 0 || ob.t0 > 0)) {
        logger.info(`[scheduler] Joined onboarding join reminders: t1=${ob.t1} t0=${ob.t0}`);
      }
    } catch (e) {
      logger.error(`runJoinedOnboardingJoiningReminders: ${e.message}`);
    }
    try {
      const { promoteAllEligibleCandidateOwnersFromScheduler } = await import('./employeeRolePromotion.service.js');
      const promoted = await promoteAllEligibleCandidateOwnersFromScheduler();
      if (promoted > 0) {
        logger.info(`[scheduler] Candidate → Employee role promotion: ${promoted} user(s) updated`);
      }
    } catch (e) {
      logger.error(`promoteAllEligibleCandidateOwnersFromScheduler: ${e.message}`);
    }
  };
  run();
  const id = setInterval(run, intervalMs);
  logger.info(`Candidate scheduler started (every ${intervalMinutes} min)`);
  return id;
};

const stopCandidateScheduler = (id) => {
  if (id) {
    clearInterval(id);
    logger.info('Candidate scheduler stopped');
    return true;
  }
  return false;
};

export { autoDeactivateResignedCandidates, sendJoiningDateReminders, startCandidateScheduler, stopCandidateScheduler };
