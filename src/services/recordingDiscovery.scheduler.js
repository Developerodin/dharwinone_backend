/**
 * Hourly discovery cron — find LiveKit egress files our DB doesn't know about.
 *
 * Why:
 *   - Egress can be triggered outside our app (LiveKit dashboard, manual API
 *     call, alternative client). Those land in storage but never create a
 *     Recording row → invisible in UI.
 *   - Our `startRecording` already sets s3Config to OUR bucket, so most files
 *     land directly in our S3. But egress started elsewhere may use LiveKit's
 *     storage. This cron handles both.
 *
 * Per tick:
 *   1. listEgress with multiple filters — collect terminal egress.
 *   2. For each egressId not in our Recording collection:
 *      a. Read fileResults to get the storage URL/key.
 *      b. If file already in our S3 (HEAD ok) → just create Recording row.
 *      c. Else: download from LiveKit's URL, upload to our S3 under the same
 *         key, then create Recording row.
 *   3. Insert via Recording.create — race-safe via unique index on egressId.
 *
 * Recordings collection is APPEND-ONLY by design (no delete paths exist).
 *
 * Wired in src/index.js — startup + SIGTERM cleanup.
 */

import { EgressClient, EgressStatus } from 'livekit-server-sdk';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import config from '../config/config.js';
import logger from '../config/logger.js';
import Recording, { recordingRank } from '../models/recording.model.js';

// 15-minute reconcile cadence. 1h was too long for the "missing recording in
// LiveKit but absent from DB" gap users reported. Discovery is idempotent
// (egressId is sparse-unique) so frequent runs are safe.
const DISCOVERY_INTERVAL_MS = 15 * 60 * 1000;
const MAX_FILE_DOWNLOAD_MB = 500;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

let intervalId = null;
let inFlight = false;

const isLiveKitCloud = (config.livekit?.url || '').includes('livekit.cloud');
const isLocalDev =
  !isLiveKitCloud &&
  (config.env !== 'production' || !config.aws?.accessKeyId || !config.aws?.secretAccessKey);

function buildS3() {
  if (isLocalDev) {
    return {
      client: new S3Client({
        region: 'us-east-1',
        endpoint: config.livekit?.minio?.endpoint || 'http://minio:9000',
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.livekit?.minio?.accessKey || 'minioadmin',
          secretAccessKey: config.livekit?.minio?.secretKey || 'minioadmin123',
        },
      }),
      bucket: config.livekit?.minio?.bucket || 'recordings',
    };
  }
  return {
    client: new S3Client({
      region: config.aws?.region || 'us-east-1',
      ...(config.aws?.accessKeyId
        ? {
            credentials: {
              accessKeyId: config.aws.accessKeyId,
              secretAccessKey: config.aws.secretAccessKey,
            },
          }
        : {}),
    }),
    bucket: config.livekit?.s3Bucket || config.aws?.bucketName,
  };
}

function nsToMs(v) {
  if (v == null || v === '') return null;
  let n;
  if (typeof v === 'bigint') n = Number(v);
  else if (typeof v === 'number') n = v;
  else {
    const s = String(v).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
      const p = Date.parse(s);
      return Number.isNaN(p) ? null : p;
    }
    try { n = Number(BigInt(s.split('.')[0])); } catch { n = Number(s); }
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e16) return Math.floor(n / 1e6);
  if (n >= 1e10) return Math.floor(n);
  return Math.floor(n * 1000);
}

async function s3Has(client, bucket, key) {
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { ok: true, size: Number(r.ContentLength || 0) };
  } catch {
    return { ok: false };
  }
}

/**
 * Mirror a LiveKit-hosted file into our S3 bucket under the same key.
 */
async function ingestRemote(client, bucket, sourceUrl, targetKey) {
  const res = await fetch(sourceUrl);
  if (!res.ok || !res.body) {
    logger.warn(`[recordingDiscovery] fetch ${sourceUrl} → ${res.status}`);
    return null;
  }
  const sizeHeader = Number(res.headers.get('content-length') || 0);
  if (sizeHeader && sizeHeader > MAX_FILE_DOWNLOAD_MB * 1024 * 1024) {
    logger.warn(`[recordingDiscovery] file ${sourceUrl} > ${MAX_FILE_DOWNLOAD_MB}MB; skipping`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return null;
  const contentType =
    res.headers.get('content-type') ||
    (targetKey.endsWith('.webm') ? 'video/webm' : 'video/mp4');
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: targetKey,
      Body: buf,
      ContentType: contentType,
    })
  );
  return { key: targetKey, bytes: buf.length };
}

function pickStorageUrlAndKey(info) {
  // LiveKit egress proto exposes file output in MULTIPLE shapes depending on
  // SDK version + whether it's the legacy single-output API or the new
  // multi-output API:
  //   info.fileResults / info.file_results / info.fileResultsList — array form
  //   info.files                                                  — alt array form
  //   info.file / info.result?.file                               — legacy singular
  // Without checking the singular form, listEgress responses on some SDK
  // versions return file data only in `info.file` and we'd flag every row
  // as "EGRESS_COMPLETE without filePath".
  const fr = info.fileResults || info.file_results || info.fileResultsList;
  const f0 =
    fr?.[0] ||
    info.files?.[0] ||
    info.file ||
    info.result?.file ||
    info.result?.value ||
    {};
  const filename = f0.filename || f0.filepath || f0.location || null;
  const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
  let key = filename;
  let sourceUrl = null;
  if (isUrl(filename)) {
    try {
      key = new URL(filename).pathname.replace(/^\/+/, '');
      sourceUrl = filename;
    } catch {
      /* not a parseable URL */
    }
  } else if (isUrl(f0.location)) {
    sourceUrl = f0.location;
  }
  return {
    sourceUrl,
    key,
    bytes: Number(f0.size || f0.bytes || 0) || null,
  };
}

async function discoverOnce() {
  if (inFlight) {
    logger.info('[recordingDiscovery] previous tick still running; skipping');
    return;
  }
  inFlight = true;
  const tickStart = Date.now();

  try {
    const apiKey = config.livekit?.apiKey;
    const apiSecret = config.livekit?.apiSecret;
    if (!apiKey || !apiSecret) {
      logger.warn('[recordingDiscovery] LiveKit creds missing; skipping');
      return;
    }
    const livekitUrl = (config.livekit?.url || 'ws://localhost:7880').replace(/^ws/, 'http');
    const eg = new EgressClient(livekitUrl, apiKey, apiSecret);
    const { client, bucket } = buildS3();
    if (!bucket) {
      logger.warn('[recordingDiscovery] no S3 bucket configured; skipping');
      return;
    }

    let inserted = 0;
    let alreadyKnown = 0;
    let failed = 0;
    let totalSeen = 0;

    // Try multiple filters since LiveKit's default may exclude completed.
    const filters = [{}, { active: false }];
    const seenIds = new Set();

    for (const filter of filters) {
      if (Date.now() - tickStart > RUN_TIMEOUT_MS) break;
      let list = [];
      try {
        list = await eg.listEgress(filter);
      } catch (err) {
        logger.warn(`[recordingDiscovery] listEgress(${JSON.stringify(filter)}) failed: ${err.message}`);
        continue;
      }
      for (const info of list || []) {
        // Snake_case fallback per LiveKit EgressInfo spec.
        const egressId = info.egressId || info.egress_id;
        if (!egressId || seenIds.has(egressId)) continue;
        seenIds.add(egressId);
        totalSeen += 1;

        // LiveKit JS SDK returns status as either a string ("EGRESS_COMPLETE")
        // or numeric enum (3) depending on version. Accept BOTH at every check.
        const statusStr = typeof info.status === 'string' ? info.status : null;
        const statusNum = Number(info.status);
        const isStarting =
          statusStr === 'EGRESS_STARTING' || statusNum === 0;
        const isActive =
          statusStr === 'EGRESS_ACTIVE' || info.status === EgressStatus.EGRESS_ACTIVE || statusNum === 1;
        const isEnding =
          statusStr === 'EGRESS_ENDING' || info.status === EgressStatus.EGRESS_ENDING || statusNum === 2;
        const isComplete =
          statusStr === 'EGRESS_COMPLETE' || info.status === EgressStatus.EGRESS_COMPLETE || statusNum === 3;
        const isFailed =
          statusStr === 'EGRESS_FAILED' || info.status === EgressStatus.EGRESS_FAILED || statusNum === 4;
        const isAborted =
          statusStr === 'EGRESS_ABORTED' || info.status === EgressStatus.EGRESS_ABORTED || statusNum === 5;
        const isLimit =
          statusStr === 'EGRESS_LIMIT_REACHED' || info.status === EgressStatus.EGRESS_LIMIT_REACHED || statusNum === 6;
        const isInProgress = isStarting || isActive || isEnding;
        const isTerminal = isComplete || isFailed || isAborted || isLimit || statusNum >= 3;

        const existing = await Recording.findOne({ egressId }).select('_id status filePath bytes s3Bucket s3Key durationMs').lean();
        if (existing) {
          // Reconcile drift: if LiveKit moved to ABORTED/FAILED but our row says
          // recording/completed, override via recordingSync (monotonic guard
          // allows same-rank enrichment for terminals). This is the cleanup
          // path for "ABORTED in LiveKit but valid in DB".
          const endedRaw = info.endedAt ?? info.ended_at;
          const endedDate = nsToMs(endedRaw) ? new Date(nsToMs(endedRaw)) : new Date();
          const liveKitErrCtx = [
            info.error || info.errorMessage,
            (info.errorCode ?? info.error_code) != null ? `code=${info.errorCode ?? info.error_code}` : null,
            info.details,
          ].filter(Boolean).join(' | ') || null;
          // Treat missing/null statusRank as 0 — legacy rows from before the
          // statusRank field existed must not be excluded by `$lte`, otherwise
          // drift fixes silently no-op and rows stay stuck on `recording`.
          const rankOrMissing = (n) => ({
            $or: [
              { statusRank: { $lte: n } },
              { statusRank: { $exists: false } },
              { statusRank: null },
            ],
          });
          if (isAborted && existing.status !== 'aborted') {
            await Recording.updateOne(
              { _id: existing._id, ...rankOrMissing(recordingRank('aborted')) },
              { $set: {
                  status: 'aborted',
                  statusRank: recordingRank('aborted'),
                  completedAt: endedDate,
                  lastError: ['Reconciled from LiveKit: EGRESS_ABORTED', liveKitErrCtx].filter(Boolean).join(' :: '),
                }
              }
            );
            logger.warn(`[recordingDiscovery] drift fixed → aborted egressId=${egressId} room=${info.roomName || info.room_name}`);
          } else if (isFailed && !['failed', 'aborted'].includes(existing.status)) {
            await Recording.updateOne(
              { _id: existing._id, ...rankOrMissing(recordingRank('failed')) },
              { $set: {
                  status: 'failed',
                  statusRank: recordingRank('failed'),
                  completedAt: endedDate,
                  lastError: ['Reconciled from LiveKit: EGRESS_FAILED', liveKitErrCtx].filter(Boolean).join(' :: '),
                }
              }
            );
            logger.warn(`[recordingDiscovery] drift fixed → failed egressId=${egressId} room=${info.roomName || info.room_name}`);
          } else if (isComplete && !['completed', 'aborted', 'failed', 'expired'].includes(existing.status)) {
            // Note: `missing` is still eligible for re-promotion. A previous
            // tick may have marked it `missing` because S3 wasn't ready yet;
            // a later tick should HEAD again and flip to `completed` if the
            // object has since landed.
            // LiveKit reports EGRESS_COMPLETE but our row is still in
            // pending/recording/stopping/finalizing — webhook `egress_ended`
            // never landed. Verify S3 then promote. This is the path that was
            // leaving recordings stuck on `recording` despite LiveKit being
            // done.
            const fileResults = info.fileResults || info.file_results || info.fileResultsList;
            const f0 = fileResults?.[0] || info.files?.[0] || info.file || info.result?.file || info.result?.value || {};
            // listEgress may return EgressInfo without file data on older
            // egresses or some SDK versions — fall back to the predicted S3
            // key the row already carries from attachEgressId so we can still
            // verify and promote to `completed`.
            const filePath = f0.filename || f0.filepath || f0.location || existing.filePath;
            const f0Bytes = Number(f0.size || f0.bytes || 0) || null;
            const f0DurationMs = nsToMs(f0.duration ?? f0.durationNs);

            if (!filePath) {
              await Recording.updateOne(
                { _id: existing._id, ...rankOrMissing(recordingRank('missing')) },
                { $set: {
                    status: 'missing',
                    statusRank: recordingRank('missing'),
                    completedAt: endedDate,
                    lastError: 'Reconciled from LiveKit: EGRESS_COMPLETE without filePath',
                  }
                }
              );
              logger.warn(`[recordingDiscovery] drift fixed → missing (no filePath) egressId=${egressId}`);
            } else {
              let s3 = await s3Has(client, bucket, filePath);
              const sourceUrl = (() => {
                const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
                if (isUrl(f0.location)) return f0.location;
                if (isUrl(f0.filename)) return f0.filename;
                return null;
              })();
              if (!s3.ok && sourceUrl) {
                try {
                  const ingest = await ingestRemote(client, bucket, sourceUrl, filePath);
                  if (ingest) s3 = { ok: true, size: ingest.bytes };
                } catch (err) {
                  logger.warn(`[recordingDiscovery] complete-drift ingest ${sourceUrl} failed: ${err.message}`);
                }
              }
              if (s3.ok && (s3.size || f0Bytes || 0) > 0) {
                await Recording.updateOne(
                  { _id: existing._id, ...rankOrMissing(recordingRank('completed')) },
                  { $set: {
                      status: 'completed',
                      statusRank: recordingRank('completed'),
                      completedAt: endedDate,
                      filePath,
                      s3Bucket: bucket,
                      s3Key: filePath,
                      bytes: s3.size || f0Bytes || existing.bytes || null,
                      durationMs: existing.durationMs || f0DurationMs || null,
                    }
                  }
                );
                logger.info(`[recordingDiscovery] drift fixed → completed egressId=${egressId} room=${info.roomName || info.room_name} bytes=${s3.size || f0Bytes}`);
              } else {
                await Recording.updateOne(
                  { _id: existing._id, ...rankOrMissing(recordingRank('missing')) },
                  { $set: {
                      status: 'missing',
                      statusRank: recordingRank('missing'),
                      completedAt: endedDate,
                      filePath,
                      lastError: s3.ok ? 'EGRESS_COMPLETE but zero bytes in S3' : 'EGRESS_COMPLETE but S3 object unreachable',
                    }
                  }
                );
                logger.warn(`[recordingDiscovery] drift fixed → missing (S3 fail) egressId=${egressId} error=${s3.error || 'zero bytes'}`);
              }
            }
          }

          // Backfill file metadata that a prior webhook/cron pass missed. Common
          // when egress_ended arrived without fileResults (e.g. ABORTED rows
          // that initially carried no path) but a later listEgress call shows
          // the file landed. Without this, UI rows stayed without S3 links
          // even though LiveKit egress had the file.
          const { sourceUrl, key, bytes: bytesFromEgress } = pickStorageUrlAndKey(info);
          const f0 = (info.fileResults || info.file_results || info.fileResultsList)?.[0]
            || info.files?.[0] || info.file || info.result?.file || info.result?.value || {};
          const f0DurationMs = nsToMs(f0.duration ?? f0.durationNs);

          const backfill = {};
          if (key && !existing.filePath) backfill.filePath = key;
          if (key && !existing.s3Key) backfill.s3Key = key;
          if (bytesFromEgress && !existing.bytes) backfill.bytes = bytesFromEgress;
          if (f0DurationMs && !existing.durationMs) backfill.durationMs = f0DurationMs;

          // If we have a key but no s3Bucket recorded, verify the object lives
          // in OUR bucket and stamp it. This restores playback for rows where
          // egress wrote to LiveKit-hosted storage and discovery later mirrored
          // it (or the file was always in our bucket but webhook missed it).
          if (key && !existing.s3Bucket) {
            let s3 = await s3Has(client, bucket, key);
            if (!s3.ok && sourceUrl) {
              try {
                const ingest = await ingestRemote(client, bucket, sourceUrl, key);
                if (ingest) s3 = { ok: true, size: ingest.bytes };
              } catch (err) {
                logger.warn(`[recordingDiscovery] backfill ingest ${sourceUrl} failed: ${err.message}`);
              }
            }
            if (s3.ok) {
              backfill.s3Bucket = bucket;
              if (!backfill.bytes && s3.size) backfill.bytes = s3.size;
            }
          }

          if (Object.keys(backfill).length) {
            await Recording.updateOne({ _id: existing._id }, { $set: backfill });
            logger.info(
              `[recordingDiscovery] backfilled file metadata egressId=${egressId} fields=${Object.keys(backfill).join(',')}`
            );
          }

          alreadyKnown += 1;
          continue;
        }

        const { sourceUrl, key, bytes: bytesFromEgress } = pickStorageUrlAndKey(info);

        // Active/starting/ending egress without a DB row: backfill so UI sees
        // in-progress recordings. Without this, egresses started outside our
        // app stayed invisible until they finished. STARTING (status=0) was
        // previously dropped entirely.
        if (isInProgress) {
          const roomName = info.roomName || info.room_name;
          if (!roomName) {
            // No room context — nothing useful to insert; webhook + cron will
            // catch it on terminal.
            continue;
          }
          const startedRaw = info.startedAt ?? info.started_at;
          const initialStatus = isEnding ? 'stopping' : 'recording';
          try {
            await Recording.create({
              meetingId: roomName,
              egressId,
              filePath: key || null,
              status: initialStatus,
              statusRank: recordingRank(initialStatus),
              startedAt: nsToMs(startedRaw) ? new Date(nsToMs(startedRaw)) : new Date(),
            });
            inserted += 1;
            logger.info(`[recordingDiscovery] inserted in-progress egressId=${egressId} status=${initialStatus} (livekit=${info.status})`);
          } catch (err) {
            if (err.code !== 11000) {
              failed += 1;
              logger.warn(`[recordingDiscovery] insert in-progress failed ${egressId}: ${err.message}`);
            } else {
              alreadyKnown += 1;
            }
          }
          continue;
        }

        if (!isTerminal) continue;

        if (!key) {
          // Terminal but no file path: insert as missing/failed/aborted depending
          // on LiveKit status so the row exists for ops.
          const status = isAborted ? 'aborted' : isFailed || isLimit ? 'failed' : 'missing';
          try {
            await Recording.create({
              meetingId: info.roomName || 'unknown',
              egressId,
              filePath: null,
              status,
              statusRank: recordingRank(status),
              startedAt: nsToMs(info.startedAt) ? new Date(nsToMs(info.startedAt)) : new Date(),
              completedAt: nsToMs(info.endedAt) ? new Date(nsToMs(info.endedAt)) : new Date(),
              lastError: `Terminal in LiveKit (status=${info.status}) without filePath`,
            });
            inserted += 1;
          } catch (err) {
            if (err.code === 11000) alreadyKnown += 1;
            else failed += 1;
          }
          continue;
        }

        let s3 = await s3Has(client, bucket, key);
        if (!s3.ok && sourceUrl) {
          try {
            const ingest = await ingestRemote(client, bucket, sourceUrl, key);
            if (ingest) s3 = { ok: true, size: ingest.bytes };
          } catch (err) {
            logger.warn(`[recordingDiscovery] ingest ${sourceUrl} failed: ${err.message}`);
          }
        }

        const startedAtMs = nsToMs(info.startedAt ?? info.started_at);
        const endedAtMs = nsToMs(info.endedAt ?? info.ended_at);
        const f0Duration = (() => {
          const fr = info.fileResults || info.file_results || info.fileResultsList;
          const f = fr?.[0] || info.files?.[0] || info.file || info.result?.file || info.result?.value || {};
          const d = f.duration ?? f.durationNs;
          return nsToMs(d);
        })();
        // Spec error fields (populated for FAILED/ABORTED).
        const liveKitError = info.error || info.errorMessage || null;
        const liveKitErrorCode = info.errorCode ?? info.error_code ?? null;
        const liveKitDetails = info.details || null;
        const errorContext = [liveKitError, liveKitErrorCode != null ? `code=${liveKitErrorCode}` : null, liveKitDetails]
          .filter(Boolean)
          .join(' | ') || null;

        // Status mapping is now driven by LiveKit egress status, not S3 size.
        // Previously: ABORTED with partial bytes → `completed` (the exact ghost
        // recording bug). Now ABORTED is always `aborted`, FAILED → `failed`,
        // and only EGRESS_COMPLETE + S3-verified > 0 bytes → `completed`.
        let status;
        let lastError = null;
        if (isAborted) {
          status = 'aborted';
          lastError = ['LiveKit reported EGRESS_ABORTED', errorContext].filter(Boolean).join(' :: ');
        } else if (isFailed || isLimit) {
          status = 'failed';
          lastError = [
            isFailed ? 'LiveKit reported EGRESS_FAILED' : 'LiveKit reported EGRESS_LIMIT_REACHED',
            errorContext,
          ].filter(Boolean).join(' :: ');
        } else if (isComplete && s3.ok && (s3.size || bytesFromEgress || 0) > 0) {
          status = 'completed';
        } else {
          status = 'missing';
          lastError = s3.ok ? 'COMPLETE but zero bytes in S3' : 'COMPLETE but S3 object unreachable';
        }

        try {
          await Recording.create({
            meetingId: info.roomName || info.room_name || 'unknown',
            egressId,
            filePath: key,
            s3Bucket: s3.ok ? bucket : null,
            s3Key: s3.ok ? key : null,
            bytes: s3.size || bytesFromEgress || null,
            status,
            statusRank: recordingRank(status),
            startedAt: startedAtMs ? new Date(startedAtMs) : new Date(),
            completedAt: endedAtMs ? new Date(endedAtMs) : new Date(),
            // Prefer egress-reported file duration (ns) per LiveKit spec; fall
            // back to startedAt-endedAt delta.
            durationMs:
              f0Duration ?? (startedAtMs && endedAtMs ? Math.max(0, endedAtMs - startedAtMs) : null),
            lastError,
          });
          inserted += 1;
          logger.info(
            `[recordingDiscovery] inserted egressId=${egressId} status=${status} room=${info.roomName} key=${key}`
          );
        } catch (err) {
          if (err.code === 11000) {
            alreadyKnown += 1;
          } else {
            failed += 1;
            logger.warn(`[recordingDiscovery] insert failed for ${egressId}: ${err.message}`);
          }
        }
      }
    }

    if (totalSeen || inserted || failed) {
      logger.info(
        `[recordingDiscovery] tick: seen=${totalSeen} known=${alreadyKnown} inserted=${inserted} failed=${failed}`
      );
    }
  } catch (err) {
    logger.error(`[recordingDiscovery] tick failed: ${err.message}`);
  } finally {
    inFlight = false;
  }
}

export function startRecordingDiscoveryScheduler() {
  if (intervalId) return intervalId;
  // Fire once at startup so a freshly-deployed instance catches up.
  discoverOnce();
  intervalId = setInterval(discoverOnce, DISCOVERY_INTERVAL_MS);
  logger.info(`[recordingDiscovery] scheduler started (every ${DISCOVERY_INTERVAL_MS / 60000} min)`);
  return intervalId;
}

export function stopRecordingDiscoveryScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[recordingDiscovery] scheduler stopped');
    return true;
  }
  return false;
}

export { discoverOnce };
