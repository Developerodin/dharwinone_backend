/**
 * Single chokepoint for Recording state changes.
 *
 * All status writes go through transitionRecording so the monotonic statusRank
 * guard prevents:
 *   - Late egress polls overwriting `completed` → `recording`.
 *   - Duplicate webhooks regressing terminal states.
 *   - Cron stomping on a row a webhook just finalized.
 *
 * Webhook + cron + manual stop all converge here.
 */

import logger from '../config/logger.js';
import Recording, { recordingRank, isRecordingTerminal } from '../models/recording.model.js';

/**
 * Monotonic status update.
 *
 * @param {string} egressId
 * @param {string} nextStatus  one of pending|recording|stopping|finalizing|completed|failed|missing|expired
 * @param {object} [patch]     Additional $set fields. Reserved keys (status/statusRank) are overwritten.
 * @param {object} [opts]
 * @param {object} [opts.inc]  $inc fields (e.g. { stopAttempts: 1 }).
 * @returns {Promise<object|null>} Updated lean document, or null if filter rejected.
 */
export async function transitionRecording(egressId, nextStatus, patch = {}, opts = {}) {
  if (!egressId) return null;
  const nextRank = recordingRank(nextStatus);
  const set = { ...patch, status: nextStatus, statusRank: nextRank };

  const update = { $set: set };
  if (opts.inc && Object.keys(opts.inc).length) {
    update.$inc = opts.inc;
  }

  // Allow same-rank enrichment (e.g. finalizing → finalizing with bytes filled in,
  // completed terminal staying terminal but adding s3Bucket/s3Key).
  // Legacy rows (created before the `statusRank` field existed) have no
  // statusRank — `$lte` does NOT match documents where the field is absent,
  // so without the $or clause those rows would silently no-op forever and
  // stay stuck on `recording` even after a successful sync.
  const filter = {
    egressId,
    $or: [
      { statusRank: { $lte: nextRank } },
      { statusRank: { $exists: false } },
      { statusRank: null },
    ],
  };
  const updated = await Recording.findOneAndUpdate(filter, update, { new: true }).lean();

  if (!updated) {
    const existing = await Recording.findOne({ egressId }).select('status statusRank').lean();
    logger.info(
      `[recordingSync] no-op egressId=${egressId}: incoming=${nextStatus}(rank=${nextRank}) existing=${existing?.status}(rank=${existing?.statusRank})`
    );
    return null;
  }

  logger.info(`[recordingSync] egressId=${egressId} → ${nextStatus} (rank=${nextRank})`);
  return updated;
}

/**
 * Insert a `pending` row before calling Egress. Eliminates the orphan window
 * where Egress is running but DB has no record (current code's `Recording.create`
 * AFTER `startRoomCompositeEgress`).
 *
 * @param {object} args
 * @param {string} args.meetingId      LiveKit room name
 * @param {string} [args.stopReason]   Audit only; usually null at start.
 * @returns {Promise<object>}          Created Mongoose document (NOT lean — caller wants _id).
 */
export async function createPending({ meetingId, stopReason = null }) {
  if (!meetingId) throw new Error('createPending: meetingId required');
  return Recording.create({
    meetingId,
    status: 'pending',
    statusRank: recordingRank('pending'),
    startedAt: new Date(),
    stopReason,
  });
}

/**
 * Attach egressId + predicted filePath after startRoomCompositeEgress success.
 * Promotes pending → recording. Idempotent on retry.
 *
 * @param {string} recordingId  _id of the pending row
 * @param {string} egressId
 * @param {string} filePath     Predicted S3 key (overwritten by webhook with actual path)
 * @returns {Promise<object>}
 */
export async function attachEgressId(recordingId, egressId, filePath) {
  if (!recordingId || !egressId) throw new Error('attachEgressId: recordingId + egressId required');
  return Recording.findByIdAndUpdate(
    recordingId,
    {
      $set: {
        egressId,
        filePath,
        status: 'recording',
        statusRank: recordingRank('recording'),
      },
    },
    { new: true }
  ).lean();
}

/**
 * Mark a pending row as failed (egress start exception). Sets statusRank=10
 * so cron + webhook never touch this row again.
 *
 * @param {string} recordingId
 * @param {string} errorMessage
 */
export async function markPendingFailed(recordingId, errorMessage) {
  if (!recordingId) return null;
  return Recording.findByIdAndUpdate(
    recordingId,
    {
      $set: {
        status: 'failed',
        statusRank: recordingRank('failed'),
        completedAt: new Date(),
        lastError: String(errorMessage || 'startRoomCompositeEgress failed').slice(0, 1000),
      },
    },
    { new: true }
  ).lean();
}

/**
 * Poll until Recording reaches a terminal/finalizing state, or timeout.
 * Used by deleteInterviewRoom to gate room deletion behind egress finalization,
 * preventing the recorder participant from being evicted mid-encode.
 *
 * @param {string} egressId
 * @param {number} [timeoutMs=30000]
 * @param {number} [pollMs=1000]
 * @returns {Promise<object|null>} Final lean doc, or null if timed out.
 */
export async function awaitRecordingTerminal(egressId, timeoutMs = 30000, pollMs = 1000) {
  if (!egressId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Recording.findOne({ egressId }).select('status statusRank').lean();
    if (!r) return null;
    if (isRecordingTerminal(r.status) || r.status === 'finalizing') return r;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return null;
}

export { isRecordingTerminal, recordingRank };

export default {
  transitionRecording,
  createPending,
  attachEgressId,
  markPendingFailed,
  awaitRecordingTerminal,
};
