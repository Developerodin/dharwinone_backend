import AgentDispatch from '../models/agentDispatch.model.js';
import Recording from '../models/recording.model.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import logger from '../config/logger.js';
import { getAgentName } from '../services/agentDispatch.service.js';
import { enqueueFinalize } from '../queues/summaryQueue.js';

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const STALE_THRESHOLD_MS = 90 * 1000;
const NEVER_JOINED_THRESHOLD_MS = 10 * 60 * 1000;
const CANCEL_SALVAGE_MS = 5 * 60 * 1000;

export function isHeartbeatStale(lastHeartbeat, thresholdMs = STALE_THRESHOLD_MS) {
  if (!lastHeartbeat) return false;
  return Date.now() - new Date(lastHeartbeat).getTime() > thresholdMs;
}

export function isNeverJoined(createdAt, now = Date.now(), thresholdMs = NEVER_JOINED_THRESHOLD_MS) {
  if (!createdAt) return false;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return false;
  return now - createdMs > thresholdMs;
}

export function salvageAction({ segmentCount }) {
  return segmentCount > 0 ? 'enqueue' : 'fail';
}

function recordingScopeFilter(dispatch) {
  return dispatch.recordingId ? { _id: dispatch.recordingId } : { meetingId: dispatch.meetingId };
}

async function segmentCountForDispatch(dispatch) {
  const { meetingId, recordingId } = dispatch;
  if (recordingId) {
    return TranscriptSegment.countDocuments({ meetingId, recordingId });
  }
  return TranscriptSegment.countDocuments({ meetingId });
}

export async function salvageOrFail(dispatch, reason) {
  const segmentCount = await segmentCountForDispatch(dispatch);
  const action = salvageAction({ segmentCount });

  if (action === 'enqueue') {
    try {
      await enqueueFinalize({
        meetingId: dispatch.meetingId,
        recordingId: dispatch.recordingId,
        segmentShortfall: true,
      });
      dispatch.status = 'completed';
      dispatch.error = reason;
      dispatch.leftAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await dispatch.save();
      logger.warn('[StuckDispatchSweeper] salvaged via finalize enqueue', {
        meetingId: dispatch.meetingId,
        dispatchId: dispatch.dispatchId,
        reason,
        segmentCount,
      });
    } catch (err) {
      logger.warn('[StuckDispatchSweeper] salvage enqueue failed', {
        meetingId: dispatch.meetingId,
        dispatchId: dispatch.dispatchId,
        error: err.message,
      });
    }
    return;
  }

  dispatch.status = 'failed';
  dispatch.error = reason;
  dispatch.leftAt = new Date();
  await dispatch.save();
  await Recording.findOneAndUpdate(
    { ...recordingScopeFilter(dispatch), aiProcessingStatus: { $in: ['dispatching', 'transcribing'] } },
    { $set: { aiProcessingStatus: 'failed', aiProcessingError: reason } }
  );
  logger.warn('[StuckDispatchSweeper] marked failed', {
    meetingId: dispatch.meetingId,
    dispatchId: dispatch.dispatchId,
    reason,
  });
}

export async function sweepStuckDispatches() {
  const summaryAgent = getAgentName();
  // Rows with a registered v2 run (agentIdentity set) belong to transcriptSessionSweeper. Do not key this on
  // dispatchKey: every summary dispatch carries one, including those still served by the v1 agent.
  const v1DispatchFilter = { agentIdentity: null };

  const cancelCutoff = new Date(Date.now() - CANCEL_SALVAGE_MS);
  const cancelStale = await AgentDispatch.find({
    agentName: summaryAgent,
    status: { $in: ['requested', 'running'] },
    cancelRequestedAt: { $ne: null, $lt: cancelCutoff },
    ...v1DispatchFilter,
  }).limit(50);
  for (const d of cancelStale) {
    // eslint-disable-next-line no-await-in-loop
    await salvageOrFail(d, 'finalize_missing_after_cancel');
  }

  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await AgentDispatch.find({
    status: 'running',
    lastHeartbeat: { $lt: cutoff },
    cancelRequestedAt: null,
    ...v1DispatchFilter,
  }).limit(50);
  for (const d of stuck) {
    // eslint-disable-next-line no-await-in-loop
    await salvageOrFail(d, 'heartbeat timeout');
  }

  const neverJoinedCutoff = new Date(Date.now() - NEVER_JOINED_THRESHOLD_MS);
  const neverJoined = await AgentDispatch.find({
    agentName: summaryAgent,
    status: 'requested',
    createdAt: { $lt: neverJoinedCutoff },
  }).limit(50);
  for (const d of neverJoined) {
    d.status = 'failed';
    d.error = 'agent_never_joined';
    d.leftAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await d.save();
    // eslint-disable-next-line no-await-in-loop
    await Recording.findOneAndUpdate(
      { ...recordingScopeFilter(d), aiProcessingStatus: 'dispatching' },
      { $set: { aiProcessingStatus: 'failed', aiProcessingError: 'agent never joined' } }
    );
    logger.warn('[StuckDispatchSweeper] never joined', { meetingId: d.meetingId, dispatchId: d.dispatchId });
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
