import Candidate from '../models/candidate.model.js';
import logger from '../config/logger.js';

/**
 * Auto deactivate candidates whose resign date has arrived.
 * @returns {Promise<number>} Number of candidates deactivated
 */
const autoDeactivateResignedCandidates = async () => {
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const candidatesToDeactivate = await Candidate.find({
      resignDate: { $lte: now },
      isActive: true,
    }).select('_id fullName email resignDate');

    if (!candidatesToDeactivate.length) return 0;

    let deactivated = 0;
    for (const candidate of candidatesToDeactivate) {
      try {
        candidate.isActive = false;
        await candidate.save();
        deactivated++;
        logger.info(
          `Auto-deactivated candidate ${candidate.fullName} (ID: ${candidate._id}, Email: ${candidate.email}) on resign date: ${candidate.resignDate.toISOString()}`
        );
      } catch (e) {
        logger.error(`Error auto-deactivating candidate ${candidate._id} (${candidate.email}): ${e.message}`);
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
 * @param {number} intervalMinutes Default 60
 * @returns {NodeJS.Timeout}
 */
const startCandidateScheduler = (intervalMinutes = 60) => {
  const intervalMs = intervalMinutes * 60 * 1000;
  const run = async () => {
    await autoDeactivateResignedCandidates();
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

export { autoDeactivateResignedCandidates, startCandidateScheduler, stopCandidateScheduler };
