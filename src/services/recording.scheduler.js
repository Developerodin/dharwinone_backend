/**
 * Recording reconciliation cron — safety net for missed webhooks and stuck egress.
 *
 * Tightened thresholds vs prior version (was 15min interval, 2h stale):
 *   - 2 min interval
 *   - 5 min "stale" cutoff for non-terminal rows
 *   - 8 h hard force-resolve for any row still active
 *
 * Resolves rows in any non-terminal state (pending/recording/stopping/finalizing)
 * by querying LiveKit egress and routing the result through recordingSync.
 *
 * Pending rows: rare. They mean startRoomCompositeEgress succeeded but
 * attachEgressId Mongo write failed. We have no egressId — mark missing.
 */

import { EgressStatus } from 'livekit-server-sdk';
import Recording, { isRecordingTerminal } from '../models/recording.model.js';
import recordingSyncService from './recordingSync.service.js';
import { headRecordingObject } from '../config/s3.js';
import logger from '../config/logger.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** Fallback cron pickup for `stopping` after stop was requested (post-stop poll handles the fast path). */
const STALE_STOPPING_THRESHOLD_MS = 30 * 1000;
const FORCE_RESOLVE_THRESHOLD_MS = 8 * 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
/** Poll LiveKit after stopEgress so DB catches terminal egress without waiting for webhook/cron. */
const AFTER_STOP_POLL_DELAYS_MS = [400, 1000, 2000, 4000, 8000];

let intervalId = null;

const NON_TERMINAL = ['pending', 'recording', 'stopping', 'finalizing'];

/**
 * Mongo filter for non-terminal rows eligible for cron reconcile.
 * `stopping` uses stopRequestedAt with a shorter window than recording/pending.
 */
export function buildStaleRecordingFilter(now = Date.now()) {
  const generalCutoff = new Date(now - STALE_THRESHOLD_MS);
  const stoppingCutoff = new Date(now - STALE_STOPPING_THRESHOLD_MS);
  return {
    $or: [
      {
        status: { $in: ['pending', 'recording', 'finalizing'] },
        startedAt: { $lt: generalCutoff },
      },
      {
        status: 'stopping',
        $or: [
          { stopRequestedAt: { $lt: stoppingCutoff } },
          { stopRequestedAt: null, startedAt: { $lt: generalCutoff } },
          { stopRequestedAt: { $exists: false }, startedAt: { $lt: generalCutoff } },
        ],
      },
    ],
  };
}

/**
 * Resolve a single stale recording. Returns final status string or null if skipped.
 */
export const reconcileRecordingFromLiveKit = async (recording, egressClient) => {
  const { egressId, _id } = recording;

  // Pending row with no egressId: orphan from a failed two-phase start.
  if (!egressId) {
    await Recording.findByIdAndUpdate(_id, {
      $set: {
        status: 'missing',
        statusRank: 10,
        completedAt: new Date(),
        lastError: 'pending row with no egressId; egress start likely failed silently',
      },
    });
    logger.warn('[Recording cron] Pending row → missing', { recordingId: String(_id) });
    return 'missing';
  }

  let egressInfo = null;
  try {
    const results = await egressClient.listEgress({ egressId });
    egressInfo = results?.[0] || null;
  } catch (err) {
    const notFound =
      err?.message?.toLowerCase().includes('not found') ||
      err?.message?.toLowerCase().includes('cannot be found');
    if (!notFound) {
      logger.warn('[Recording cron] Egress lookup error', { egressId, error: err.message });
      return null;
    }
  }

  const now = new Date();

  // Egress purged from LiveKit → mark missing.
  if (!egressInfo) {
    await recordingSyncService.transitionRecording(egressId, 'missing', {
      completedAt: now,
      lastError: 'Egress purged from LiveKit',
    });
    logger.info('[Recording cron] Resolved purged egress → missing', { egressId, recordingId: String(_id) });
    return 'missing';
  }

  const egressStatus = egressInfo.status;
  // LiveKit JS SDK ships status as string or number depending on version.
  // Accept both forms — numeric-only comparison was leaving COMPLETE rows
  // stuck on `recording` because the SDK was returning the string name.
  const statusStr = typeof egressStatus === 'string' ? egressStatus : null;
  const statusNum = Number(egressStatus);
  const isComplete =
    statusStr === 'EGRESS_COMPLETE' || egressStatus === EgressStatus.EGRESS_COMPLETE || statusNum === 3;
  const isFailed =
    statusStr === 'EGRESS_FAILED' || egressStatus === EgressStatus.EGRESS_FAILED || statusNum === 4;
  const isAborted =
    statusStr === 'EGRESS_ABORTED' || egressStatus === EgressStatus.EGRESS_ABORTED || statusNum === 5;
  const isLimit =
    statusStr === 'EGRESS_LIMIT_REACHED' || egressStatus === EgressStatus.EGRESS_LIMIT_REACHED || statusNum === 6;
  const isTerminal = isComplete || isFailed || isAborted || isLimit || statusNum >= 3;

  if (!isTerminal) {
    const startedAt = new Date(recording.startedAt);
    if (Number.isNaN(startedAt.getTime())) {
      await recordingSyncService.transitionRecording(egressId, 'missing', {
        completedAt: now,
        lastError: 'Invalid startedAt during reconcile',
      });
      return 'missing';
    }
    const age = now - startedAt;
    if (age < FORCE_RESOLVE_THRESHOLD_MS) {
      // Still active and within window — leave it. Next webhook should resolve.
      return null;
    }
    logger.warn('[Recording cron] Force-resolving active egress > 8h', { egressId });
  }

  // Terminal in LiveKit; figure out filePath + status.
  const fileResults =
    egressInfo.fileResults || egressInfo.file_results || egressInfo.fileResultsList;
  // Legacy SDK / API may emit file output under singular `file` instead of
  // the `file_results` array — accept both, otherwise terminal rows fall
  // through to `missing` even when LiveKit wrote a real file.
  const f0 =
    fileResults?.[0] ||
    egressInfo.files?.[0] ||
    egressInfo.file ||
    egressInfo.result?.file ||
    egressInfo.result?.value ||
    {};
  // Fall back to the predicted S3 key the row carries from attachEgressId
  // when listEgress returns EgressInfo without file data.
  const filePath = f0.filename || f0.filepath || f0.location || recording.filePath;
  const bytes = Number(f0.size || f0.bytes || 0) || null;
  // file_results[].duration in ns per LiveKit egress spec. Prefer it for the
  // playback duration shown in UI.
  const fileDurationMs = (() => {
    const d = f0.duration ?? f0.durationNs;
    if (d == null || d === '') return null;
    if (typeof d === 'bigint') return Number(d / 1000000n);
    if (typeof d === 'number' && Number.isFinite(d)) {
      return d >= 1e10 ? Math.floor(d / 1e6) : Math.floor(d);
    }
    const s = String(d).trim();
    if (/^\d+$/.test(s)) {
      try {
        const intPart = BigInt(s);
        if (intPart >= 10000000000000000n) return Number(intPart / 1000000n);
        return Math.floor(Number(intPart) / 1e6);
      } catch {
        return null;
      }
    }
    return null;
  })();
  // Spec error fields populated for FAILED/ABORTED.
  const liveKitError = egressInfo.error || egressInfo.errorMessage || null;
  const liveKitErrorCode = egressInfo.errorCode ?? egressInfo.error_code ?? null;
  const liveKitDetails = egressInfo.details || null;
  const errorContext = [
    liveKitError,
    liveKitErrorCode != null ? `code=${liveKitErrorCode}` : null,
    liveKitDetails,
  ].filter(Boolean).join(' | ') || null;

  // LiveKit endedAt: ns (bigint/string), ms, or seconds. Branch by magnitude.
  const endedAtRaw = egressInfo.endedAt ?? egressInfo.ended_at;
  let endedMs = null;
  if (endedAtRaw != null && endedAtRaw !== '') {
    let n;
    const epochNsToMs = (bi) => Number(bi / 1000000n);
    if (typeof endedAtRaw === 'bigint') {
      endedMs = epochNsToMs(endedAtRaw);
    } else if (typeof endedAtRaw === 'number') {
      n = endedAtRaw;
    } else {
      const s = String(endedAtRaw).trim();
      if (/^\d+(\.\d+)?$/.test(s)) {
        try {
          const intPart = BigInt(s.split('.')[0]);
          if (intPart >= 10000000000000000n) {
            endedMs = epochNsToMs(intPart);
          } else {
            n = Number(intPart);
          }
        } catch {
          n = Number(s);
        }
      } else {
        const parsed = Date.parse(s);
        n = Number.isNaN(parsed) ? null : parsed;
      }
    }
    if (endedMs == null && Number.isFinite(n) && n > 0) {
      if (n >= 1e16) endedMs = Math.floor(n / 1e6);
      else if (n >= 1e10) endedMs = Math.floor(n);
      else endedMs = Math.floor(n * 1000);
    }
  }
  const completedAt = endedMs ? new Date(endedMs) : now;

  // ABORTED is its own terminal — never report as `completed`, even if a partial
  // file landed in S3. UI must hide aborted recordings. Capture key/bucket so
  // ops can investigate, but mark `aborted` so listAll filters it out.
  if (isAborted) {
    await recordingSyncService.transitionRecording(egressId, 'aborted', {
      completedAt,
      filePath: filePath || null,
      bytes: bytes || null,
      durationMs: fileDurationMs,
      lastError: [
        `LiveKit reported EGRESS_ABORTED (status=${egressStatus})`,
        errorContext,
      ].filter(Boolean).join(' :: '),
    });
    logger.warn('[Recording cron] Resolved → aborted', { egressId, recordingId: String(_id), filePath, errorContext });
    return 'aborted';
  }

  if (isFailed || isLimit) {
    await recordingSyncService.transitionRecording(egressId, 'failed', {
      completedAt,
      filePath: filePath || null,
      bytes: bytes || null,
      durationMs: fileDurationMs,
      lastError: [
        `LiveKit reported ${isFailed ? 'EGRESS_FAILED' : 'EGRESS_LIMIT_REACHED'} (status=${egressStatus})`,
        errorContext,
      ].filter(Boolean).join(' :: '),
    });
    logger.warn('[Recording cron] Resolved → failed', { egressId, recordingId: String(_id), errorContext });
    return 'failed';
  }

  // EGRESS_COMPLETE path: only mark `completed` after S3 HEAD verifies size > 0.
  // This closes the gap where webhook delivery failed but cron ran first.
  if (filePath) {
    const verified = await headRecordingObject(filePath);
    if (verified.ok && (verified.size || bytes || 0) > 0) {
      await recordingSyncService.transitionRecording(egressId, 'completed', {
        completedAt,
        filePath,
        bytes: verified.size || bytes,
        s3Bucket: verified.bucket,
        s3Key: verified.key,
        durationMs: fileDurationMs,
      });
      logger.info('[Recording cron] Resolved → completed (S3 verified)', { egressId, recordingId: String(_id) });
      return 'completed';
    }
    await recordingSyncService.transitionRecording(egressId, 'missing', {
      completedAt,
      filePath,
      lastError: `S3 verify failed during reconcile: ${verified.error || 'object not found or zero bytes'}`,
    }, { inc: { verifyAttempts: 1 } });
    logger.warn('[Recording cron] Resolved → missing (S3 verify failed)', { egressId, recordingId: String(_id), error: verified.error });
    return 'missing';
  }

  await recordingSyncService.transitionRecording(egressId, 'missing', {
    completedAt,
    lastError: 'Terminal in LiveKit but no filePath in egressInfo',
  });
  logger.info('[Recording cron] Resolved → missing (no filePath)', { egressId, recordingId: String(_id) });
  return 'missing';
};

/**
 * After stopEgress, poll LiveKit until egress is terminal or attempts exhaust.
 * Idempotent with webhook — transitionRecording monotonic guard handles races.
 */
export const pollReconcileAfterStop = async (egressId, egressClient) => {
  if (!egressId || !egressClient) return;

  for (let i = 0; i < AFTER_STOP_POLL_DELAYS_MS.length; i += 1) {
    const delayMs = AFTER_STOP_POLL_DELAYS_MS[i];
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

    const rec = await Recording.findOne({ egressId }).lean();
    if (!rec) return;
    if (isRecordingTerminal(rec.status)) return;
    if (rec.status !== 'stopping' && rec.status !== 'finalizing') return;

    const result = await reconcileRecordingFromLiveKit(rec, egressClient);
    if (result) {
      logger.info('[Recording reconcile] post-stop resolved', { egressId, result, attempt: i + 1 });
      return;
    }
  }
};

export const runRecoveryPass = async (egressClient) => {
  if (!egressClient) return;

  const stale = await Recording.find({
    ...buildStaleRecordingFilter(),
    status: { $in: NON_TERMINAL },
  })
    .limit(200)
    .lean();

  if (!stale.length) return;

  logger.info(`[Recording cron] ${stale.length} stale row(s) — resolving`);

  let completed = 0;
  let missing = 0;
  let skipped = 0;

  for (const rec of stale) {
    try {
      const result = await reconcileRecordingFromLiveKit(rec, egressClient);
      if (result === 'completed') completed += 1;
      else if (result === 'missing') missing += 1;
      else skipped += 1;
    } catch (err) {
      logger.error('[Recording cron] resolve failed', { recordingId: String(rec._id), error: err.message });
      skipped += 1;
    }
  }

  logger.info(`[Recording cron] pass done — completed:${completed} missing:${missing} skipped:${skipped}`);
};

export const startRecordingScheduler = (egressClient) => {
  if (intervalId) return;
  runRecoveryPass(egressClient);
  intervalId = setInterval(() => runRecoveryPass(egressClient), RECONCILE_INTERVAL_MS);
  logger.info(
    `[Recording cron] started (interval: ${RECONCILE_INTERVAL_MS / 60000} min, stale: ${
      STALE_THRESHOLD_MS / 60000
    } min, stopping stale: ${STALE_STOPPING_THRESHOLD_MS / 1000}s)`
  );
};

export const stopRecordingScheduler = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Recording cron] stopped');
  }
};
