import AgentDispatch from '../models/agentDispatch.model.js';
import Recording from '../models/recording.model.js';
import logger from '../config/logger.js';

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const STALE_THRESHOLD_MS = 90 * 1000;

export function isHeartbeatStale(lastHeartbeat, thresholdMs = STALE_THRESHOLD_MS) {
  if (!lastHeartbeat) return false;
  return Date.now() - new Date(lastHeartbeat).getTime() > thresholdMs;
}

export async function sweepStuckDispatches() {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await AgentDispatch.find({
    status: 'running',
    lastHeartbeat: { $lt: cutoff },
  }).limit(50);
  for (const d of stuck) {
    d.status = 'failed';
    d.error = 'heartbeat timeout';
    d.leftAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await d.save();
    // eslint-disable-next-line no-await-in-loop
    await Recording.findOneAndUpdate(
      { meetingId: d.meetingId, aiProcessingStatus: 'transcribing' },
      { $set: { aiProcessingStatus: 'failed', aiProcessingError: 'agent heartbeat timeout' } }
    );
    logger.warn('[StuckDispatchSweeper] marked failed', {
      meetingId: d.meetingId,
      dispatchId: d.dispatchId,
    });
  }
}

let intervalHandle = null;
export function startStuckDispatchSweeper() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    sweepStuckDispatches().catch((err) =>
      logger.error('[StuckDispatchSweeper] error', { error: err.message })
    );
  }, SWEEP_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopStuckDispatchSweeper() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
