import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import httpStatus from 'http-status';
import { WebhookReceiver, EgressStatus } from 'livekit-server-sdk';
import catchAsync from '../utils/catchAsync.js';
import Recording from '../models/recording.model.js';
import ChatCall from '../models/chatCall.model.js';
import logger from '../config/logger.js';
import config from '../config/config.js';
import { headRecordingObject } from '../config/s3.js';
import recordingSyncService from '../services/recordingSync.service.js';
import * as livekitService from '../services/livekit.service.js';
import {
  computeEventId,
  computeBodyHash,
  claimWebhookEvent,
} from '../services/webhookIdempotency.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.resolve(__dirname, '../../recordings');

/**
 * LiveKit timestamps in webhook payloads vary by version: nanoseconds (bigint
 * or string of digits), milliseconds (Date.now), or seconds (Unix). Branch by
 * magnitude — ALL forms eventually map to ms epoch.
 *
 * Magnitude bands (assuming 21st-century timestamps):
 *   < 1e10  → seconds   (e.g. 1.7e9)
 *   1e10–1e15 → ms      (e.g. 1.7e12)
 *   > 1e15   → ns       (e.g. 1.7e18)
 */
function nsToMs(v) {
  if (v == null || v === '') return null;
  let n;
  if (typeof v === 'bigint') {
    n = Number(v);
  } else if (typeof v === 'number') {
    n = v;
  } else {
    const s = String(v).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
      const parsed = Date.parse(s);
      return Number.isNaN(parsed) ? null : parsed;
    }
    try {
      n = Number(BigInt(s.split('.')[0]));
    } catch {
      n = Number(s);
    }
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e16) return Math.floor(n / 1e6); // nanoseconds → ms
  if (n >= 1e10) return Math.floor(n);       // already ms
  return Math.floor(n * 1000);               // seconds → ms
}

/** Save webhook payload to local recordings folder for forensics. */
const savePayloadLocally = async (payload) => {
  try {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
    const info = payload?.egressInfo || {};
    const egressId = info.egressId || info.id || 'unknown';
    const ts = Date.now();
    const filename = `egress-${egressId}-${ts}.json`;
    const filepath = path.join(RECORDINGS_DIR, filename);
    const data = { receivedAt: new Date().toISOString(), ...payload };
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
    logger.info('[LiveKit Webhook] Saved locally', { filepath });
  } catch (err) {
    logger.warn('[LiveKit Webhook] Failed to save locally', { error: err.message });
  }
};

/** Pull email from participant metadata if it's JSON. */
function metadataEmail(metadata) {
  if (!metadata || typeof metadata !== 'string') return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed?.email || null;
  } catch {
    return null;
  }
}

/**
 * On participant_left: if departing identity is a meeting host, stop any
 * active egress for that room. Without this, host closing tab → recording
 * sat in `recording` until 2h cron picked it up.
 */
async function handleParticipantLeft(payload) {
  const roomName = payload?.room?.name;
  const participant = payload?.participant || {};
  const identity = participant.identity;
  const email = metadataEmail(participant.metadata);

  if (!roomName || (!email && !identity)) return;

  const isHost = email ? await livekitService.isParticipantHost(roomName, email) : false;
  if (!isHost) return;

  const egressClient = livekitService.getEgressClient?.();
  if (!egressClient) return;

  try {
    const active = await egressClient.listEgress({ roomName });
    for (const eg of active) {
      if (eg.status === EgressStatus.EGRESS_ACTIVE) {
        logger.info('[LiveKit Webhook] host_leave: stopping egress', { roomName, egressId: eg.egressId, identity });
        livekitService
          .stopRecording(eg.egressId, roomName, 'host_leave')
          .catch((err) => logger.warn(`[LiveKit Webhook] host_leave stop failed: ${err.message}`));
      }
    }
  } catch (err) {
    logger.warn(`[LiveKit Webhook] participant_left listEgress failed: ${err.message}`);
  }
}

/**
 * On room_finished: catch any egress that was still active (e.g. last
 * participant disconnected without explicit end). Stop them, and atomically
 * close any `ChatCall` whose livekitRoom matches — without this the chat call
 * sat in `ongoing` until the 6h cron, surfacing as a ghost call.
 */
async function handleRoomFinished(payload) {
  const roomName = payload?.room?.name;
  if (!roomName) return;
  const egressClient = livekitService.getEgressClient?.();

  if (egressClient) {
    try {
      const active = await egressClient.listEgress({ roomName });
      for (const eg of active) {
        if (eg.status === EgressStatus.EGRESS_ACTIVE) {
          logger.info('[LiveKit Webhook] room_finished: stopping egress', { roomName, egressId: eg.egressId });
          livekitService
            .stopRecording(eg.egressId, roomName, 'room_finished')
            .catch((err) => logger.warn(`[LiveKit Webhook] room_finished stop failed: ${err.message}`));
        }
      }
    } catch (err) {
      logger.warn(`[LiveKit Webhook] room_finished listEgress failed: ${err.message}`);
    }
  }

  // Close any ChatCall tied to this room. Conditional update never regresses
  // completed/declined/missed rows. duration is computed in the aggregation
  // pipeline so it stays consistent with startedAt at the moment of close.
  if (roomName.startsWith('chat-')) {
    try {
      const res = await ChatCall.updateOne(
        { livekitRoom: roomName, status: { $in: ['ringing', 'ongoing'] } },
        [
          {
            $set: {
              status: { $cond: [{ $eq: ['$status', 'ringing'] }, 'missed', 'completed'] },
              endedAt: '$$NOW',
              duration: {
                $cond: [
                  { $ifNull: ['$startedAt', false] },
                  { $round: [{ $divide: [{ $subtract: ['$$NOW', '$startedAt'] }, 1000] }, 0] },
                  0,
                ],
              },
            },
          },
        ]
      );
      if (res.modifiedCount) {
        logger.info('[LiveKit Webhook] room_finished: closed ChatCall', { roomName });
      }
    } catch (err) {
      logger.warn(`[LiveKit Webhook] room_finished ChatCall close failed: ${err.message}`);
    }
  }

  // Cancel any orphan AI summary dispatch tied to this room.
  try {
    const { cancelDispatch } = await import('../services/agentDispatch.service.js');
    await cancelDispatch(roomName);
  } catch (err) {
    logger.warn('[LiveKit Webhook] cancelDispatch failed', { roomName, error: err.message });
  }
}

/**
 * On egress_ended: confirm S3 actually has the file with non-zero bytes BEFORE
 * marking completed. Routes through recordingSync so duplicate webhooks cannot
 * regress an already-completed row.
 */
async function handleEgressEnded(payload) {
  const info = payload.egressInfo || {};
  // LiveKit ships snake_case in raw HTTP webhook JSON (egress_id, room_name,
  // file_results, started_at, ended_at, error_code, error) but camelCase via
  // the SDK proto bridge. Read both. Spec:
  // https://docs.livekit.io/reference/other/egress/api/#egressinfo
  const egressId = info.egressId || info.egress_id || info.id;
  if (!egressId) {
    logger.warn('[LiveKit Webhook] egress_ended missing egressId', payload);
    return;
  }

  const endedAtRaw = info.endedAt ?? info.ended_at;
  const endedMs = nsToMs(endedAtRaw) || Date.now();
  const completedAt = new Date(endedMs);

  const fileResults = info.fileResults || info.file_results || info.fileResultsList;
  // Legacy SDK / API may emit file output under singular `file` (or oneof
  // `result.file`) instead of `file_results` array — accept both shapes,
  // otherwise EGRESS_COMPLETE webhooks would route to `missing` even when
  // LiveKit successfully wrote a real file to S3.
  const f0 =
    fileResults?.[0] ||
    info.files?.[0] ||
    info.file ||
    info.result?.file ||
    info.result?.value ||
    {};
  const filePath = f0.filename || f0.filepath || f0.location;
  const bytesFromEgress = Number(f0.size || f0.bytes || 0) || null;
  // file_results[].duration is reported in nanoseconds. Prefer it over the
  // computed startedAt→completedAt delta because Egress finalize timestamps
  // can drift several seconds after the encoder actually stopped.
  const durationFromEgressMs = (() => {
    const d = f0.duration ?? f0.durationNs;
    if (d == null || d === '') return null;
    const ms = nsToMs(d);
    return Number.isFinite(ms) && ms > 0 && ms < 24 * 60 * 60 * 1000 ? ms : null;
  })();
  // Spec fields for failure context — `error` + `error_code` populated for
  // FAILED/ABORTED, `details` for additional context. Surface to ops via lastError.
  const errorMsg = info.error || info.errorMessage || null;
  const errorCode = info.errorCode ?? info.error_code ?? null;
  const details = info.details || null;
  const errorContext = [errorMsg, errorCode != null ? `code=${errorCode}` : null, details]
    .filter(Boolean)
    .join(' | ') || null;

  // Egress status drives DB state, NOT just file presence. Previously this
  // function only branched on S3 verify; an ABORTED egress with partial bytes
  // landed as `completed` and surfaced to UI as a valid recording.
  const statusNum = Number(info.status);
  const isComplete = info.status === 'EGRESS_COMPLETE' || statusNum === 3;
  const isFailed = info.status === 'EGRESS_FAILED' || statusNum === 4;
  const isAborted = info.status === 'EGRESS_ABORTED' || statusNum === 5;
  const isLimit = info.status === 'EGRESS_LIMIT_REACHED' || statusNum === 6;

  if (isAborted) {
    await recordingSyncService.transitionRecording(egressId, 'aborted', {
      completedAt,
      filePath: filePath || null,
      bytes: bytesFromEgress,
      durationMs: durationFromEgressMs,
      lastError: ['LiveKit egress_ended status=EGRESS_ABORTED', errorContext].filter(Boolean).join(' :: '),
    });
    logger.warn('[LiveKit Webhook] egress aborted', { egressId, filePath, errorContext });
    return;
  }

  if (isFailed || isLimit) {
    await recordingSyncService.transitionRecording(egressId, 'failed', {
      completedAt,
      filePath: filePath || null,
      bytes: bytesFromEgress,
      durationMs: durationFromEgressMs,
      lastError: [
        isFailed ? 'LiveKit egress_ended status=EGRESS_FAILED' : 'LiveKit egress_ended status=EGRESS_LIMIT_REACHED',
        errorContext,
      ].filter(Boolean).join(' :: '),
    });
    logger.warn('[LiveKit Webhook] egress failed', { egressId, status: info.status, errorContext });
    return;
  }

  if (!filePath) {
    await recordingSyncService.transitionRecording(egressId, 'missing', {
      completedAt,
      lastError: 'egress_ended without filePath',
    });
    return;
  }

  // Only EGRESS_COMPLETE reaches here. Refuse to mark `completed` for unknown
  // statuses — better a `missing` row than a ghost recording in the UI.
  if (!isComplete) {
    logger.warn('[LiveKit Webhook] unknown egress status on egress_ended; routing → missing', { egressId, status: info.status });
    await recordingSyncService.transitionRecording(egressId, 'missing', {
      completedAt,
      filePath,
      lastError: `Unknown egress status: ${info.status}`,
    });
    return;
  }

  // Move to finalizing first; capture filePath + bytes from egress.
  await recordingSyncService.transitionRecording(egressId, 'finalizing', {
    finalizingAt: new Date(),
    filePath,
    bytes: bytesFromEgress,
  });

  // Verify S3 actually has the object with non-zero bytes.
  const verified = await headRecordingObject(filePath);
  if (verified.ok && (verified.size || bytesFromEgress || 0) > 0) {
    // Prefer the egress-reported duration (file_results[].duration in ns) per
    // LiveKit spec; fall back to startedAt-completedAt delta.
    let durationMs = durationFromEgressMs;
    if (durationMs == null) {
      const recordingForDuration = await Recording.findOne({ egressId }).select('startedAt').lean();
      durationMs = recordingForDuration?.startedAt
        ? Math.max(0, completedAt.getTime() - new Date(recordingForDuration.startedAt).getTime())
        : null;
    }

    const updated = await recordingSyncService.transitionRecording(egressId, 'completed', {
      completedAt,
      bytes: verified.size || bytesFromEgress,
      s3Bucket: verified.bucket,
      s3Key: verified.key,
      durationMs,
    });

    if (updated?.meetingId?.startsWith?.('chat-')) {
      await ChatCall.findOneAndUpdate(
        { livekitRoom: updated.meetingId },
        { $set: { recordingId: updated._id } }
      ).catch(() => {});
      logger.info('[LiveKit Webhook] ChatCall linked to recording', {
        roomName: updated.meetingId,
        recordingId: updated._id?.toString?.(),
      });
    }
  } else {
    await recordingSyncService.transitionRecording(
      egressId,
      'missing',
      {
        completedAt,
        lastError: `S3 verify failed: ${verified.error || 'object not found or zero bytes'}`,
      },
      { inc: { verifyAttempts: 1 } }
    );
    logger.warn('[LiveKit Webhook] S3 HEAD verify failed', { egressId, filePath, error: verified.error });
  }
}

/**
 * Handle LiveKit webhook events.
 *
 * Configure URL in LiveKit Cloud (Settings → Webhooks) or self-hosted
 * server.yaml (webhook.urls). Subscribe to: egress_started, egress_updated,
 * egress_ended, participant_left, room_finished.
 */
const receiveLiveKitEgressWebhook = catchAsync(async (req, res) => {
  const raw =
    req.rawBody && Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : typeof req.body === 'object' && req.body !== null
        ? JSON.stringify(req.body)
        : String(req.body || '');

  const { apiKey, apiSecret } = config.livekit || {};
  const hasLiveKitCreds = Boolean(apiKey && apiSecret);

  if (config.env === 'production' && !hasLiveKitCreds) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
      status: 'error',
      message: 'LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in production to verify egress webhooks.',
    });
  }

  if (hasLiveKitCreds) {
    try {
      const receiver = new WebhookReceiver(apiKey, apiSecret);
      await receiver.receive(raw, req.get('Authorization') || '', false);
    } catch (err) {
      logger.warn('[LiveKit Webhook] Verification failed', { error: err.message });
      return res.status(httpStatus.UNAUTHORIZED).json({ status: 'error', message: 'Invalid LiveKit webhook signature' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return res.status(httpStatus.BAD_REQUEST).json({ status: 'error', message: 'Invalid JSON body' });
  }

  const event = payload?.event;

  // Idempotency guard: LiveKit may redeliver webhooks; suppress duplicates.
  const explicitId = req.get('x-livekit-webhook-id') || req.get('webhook-id') || null;
  const timestamp = req.get('x-livekit-timestamp') || req.get('webhook-timestamp') || '';
  const eventId = computeEventId({ explicitId, timestamp, body: raw });
  const bodyHash = computeBodyHash(raw);
  const isFresh = await claimWebhookEvent({
    eventId,
    event,
    roomName: payload?.room?.name,
    bodyHash,
  });
  if (!isFresh) {
    return res.status(httpStatus.OK).json({ status: 'duplicate_suppressed' });
  }

  // Snake_case is the wire format per LiveKit egress spec; camelCase comes via
  // SDK proto bridge. Read both at every entry point.
  const egInfo = payload?.egressInfo || {};
  const topEgressId = egInfo.egressId || egInfo.egress_id || egInfo.id;
  logger.info('[LiveKit Webhook] Received', {
    event,
    egressId: topEgressId,
    egressStatus: egInfo.status,
    room: payload?.room?.name,
  });

  await savePayloadLocally(payload);

  try {
    if (event === 'egress_started') {
      const egressId = topEgressId;
      if (egressId) {
        const startedRaw = egInfo.startedAt ?? egInfo.started_at;
        await recordingSyncService.transitionRecording(egressId, 'recording', {
          startedAt: new Date(nsToMs(startedRaw) || Date.now()),
        });
      }
    } else if (event === 'egress_updated') {
      const egressId = topEgressId;
      const status = egInfo.status;
      // EGRESS_ENDING: 2 (numeric) OR string 'EGRESS_ENDING'
      if (egressId && (status === 'EGRESS_ENDING' || Number(status) === 2)) {
        await recordingSyncService.transitionRecording(egressId, 'stopping', {});
      }
    } else if (event === 'egress_ended') {
      await handleEgressEnded(payload);
    } else if (event === 'participant_left') {
      await handleParticipantLeft(payload);
    } else if (event === 'room_finished') {
      await handleRoomFinished(payload);
    }
  } catch (err) {
    logger.error('[LiveKit Webhook] Handler error', { event, error: err?.message });
  }

  res.status(httpStatus.OK).json({ status: 'received' });
});

export { receiveLiveKitEgressWebhook };
