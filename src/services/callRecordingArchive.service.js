/**
 * Persist Bolna + Plivo call recordings to S3 for future review.
 *
 * Recordings normally live only on Bolna (agent leg) and Plivo (dual-channel)
 * servers, which expire/rotate them. This service mirrors both to our own S3
 * bucket so a recruiter can still review a call months later.
 *
 * - Source resolution (`resolveCallRecordingSources`, `headersForRecordingUrl`)
 *   lives here so both the controller's streaming endpoints and the archival
 *   path share one implementation without a circular import.
 * - `archiveCallRecordings` is idempotent and per-source: it skips a source that
 *   is already archived, so it can be re-run safely (e.g. Plivo's dual-channel
 *   recording often finalizes a little after the call ends).
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, generatePresignedDownloadUrl } from '../config/s3.js';
import config from '../config/config.js';
import logger from '../config/logger.js';
import bolnaService from './bolna.service.js';
import plivoService from './plivo.service.js';
import callRecordService from './callRecord.service.js';
import CallRecord, { TERMINAL_STATUSES } from '../models/callRecord.model.js';

/**
 * Pick upstream auth for a recording URL (Bolna vs Plivo-hosted media).
 *
 * Credentials are attached ONLY to an exact host allowlist. The URL comes from a
 * third-party API response (`recording_url` / Plivo recording list), so a spoofed
 * or compromised value must never be able to harvest our Bolna/Plivo secrets:
 *   - substring matching (`includes('plivo.com')`) would match `plivo.com.evil.tld`
 *   - a permissive default would send the Bolna token to ANY host
 * Fail closed: unknown or malformed host → no credentials (works for presigned
 * S3/CDN URLs that need none; leaks nothing to an attacker host).
 */
export function headersForRecordingUrl(url) {
  let host;
  try {
    host = new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (host === 'plivo.com' || host.endsWith('.plivo.com')) {
    const basic = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  if (host === 'bolna.ai' || host.endsWith('.bolna.ai')) {
    const { apiKey } = bolnaService.getConfig();
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}

/**
 * Resolve both recording sources for a call from its Bolna executionId:
 *   - Bolna's own recording (agent leg only)
 *   - Plivo's recording (DUAL-CHANNEL — both agent and caller)
 * Bolna exposes the Plivo call UUID as telephony_data.provider_call_id.
 * Falls back to CallRecord.recordingUrl / telephonyData when the live Bolna
 * execution payload has not yet (or never) exposed telephony_data.
 */
export async function resolveCallRecordingSources(executionId) {
  const stored = await callRecordService.getCallRecordingFields(executionId);
  const storedTel =
    stored?.telephonyData && typeof stored.telephonyData === 'object' ? stored.telephonyData : {};
  let bolnaUrl = stored?.recordingUrl || storedTel.recording_url || null;
  let providerCallId = storedTel.provider_call_id || null;
  let provider = storedTel.provider || null;
  let execError = null;

  const exec = await bolnaService.getExecutionFull(executionId);
  if (exec.success && exec.details) {
    const tel = exec.details.telephony_data || {};
    bolnaUrl = tel.recording_url || exec.details.recording_url || bolnaUrl;
    providerCallId = tel.provider_call_id || providerCallId;
    provider = tel.provider || provider;
  } else {
    execError = exec.error || 'Failed to fetch call details from Bolna';
  }

  let plivo = [];
  if (providerCallId) {
    const r = await plivoService.getCallRecordings(providerCallId);
    if (r.success) plivo = (r.recordings || []).filter((x) => x.recordingUrl);
  }

  return { bolnaUrl, providerCallId, plivo, provider, execError };
}

/** Download a remote (auth-protected) recording into a Buffer. */
async function downloadToBuffer(url, headers) {
  const upstream = await fetch(url, { headers });
  if (!upstream.ok) {
    throw new Error(`upstream fetch failed (${upstream.status})`);
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type') || null;
  return { buffer, contentType };
}

/** PutObject a recording buffer into the main app bucket. Returns the stored key. */
async function putRecordingObject(key, buffer, contentType, metadata) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'audio/mpeg',
      Metadata: metadata,
    })
  );
  return key;
}

/** Guess a file extension from content-type / URL (Bolna can be wav, Plivo is mp3). */
function extFor(contentType, url, fallback) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('wav')) return 'wav';
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  const u = String(url || '').toLowerCase();
  if (u.includes('.wav')) return 'wav';
  if (u.includes('.mp3')) return 'mp3';
  return fallback;
}

/** Archive a single source (bolna|plivo) if present and not already stored. */
async function archiveOne({ executionId, existing, kind, url, force }) {
  if (!url) return { kind, status: 'no_source' };
  if (!force && existing?.key) return { kind, status: 'already', entry: existing };

  const fallbackExt = kind === 'plivo' ? 'mp3' : 'wav';
  const { buffer, contentType } = await downloadToBuffer(url, headersForRecordingUrl(url));
  const ext = extFor(contentType, url, fallbackExt);
  const key = `call-recordings/${executionId}/${kind}.${ext}`;
  const resolvedType = contentType || (ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
  await putRecordingObject(key, buffer, resolvedType, {
    executionId,
    kind,
    archivedAt: new Date().toISOString(),
  });

  return {
    kind,
    status: 'archived',
    entry: {
      key,
      bucket: config.aws.bucketName,
      size: buffer.length,
      contentType: resolvedType,
      sourceUrl: url,
      archivedAt: new Date(),
    },
  };
}

/**
 * Archive the Bolna + Plivo recordings for a call to S3. Idempotent and
 * per-source. Safe to call from the completion webhook and again lazily on
 * playback (Plivo's recording may lag the call end).
 *
 * @param {string} executionId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ executionId: string, bolna: string, plivo: string, skipped?: string }>}
 */
export async function archiveCallRecordings(executionId, { force = false } = {}) {
  if (!executionId) return { executionId, bolna: 'no_source', plivo: 'no_source', skipped: 'no_execution' };
  if (!config.aws?.bucketName) {
    logger.warn('[callRecordingArchive] AWS_S3_BUCKET_NAME not set — skipping recording archive');
    return { executionId, bolna: 'no_bucket', plivo: 'no_bucket', skipped: 'no_bucket' };
  }

  const record = await CallRecord.findOne({ executionId }).select('recordingArchive');
  if (!record) return { executionId, bolna: 'no_record', plivo: 'no_record', skipped: 'no_record' };

  const existing = record.recordingArchive || {};
  // Fast path: both sources already mirrored.
  if (!force && existing.bolna?.key && existing.plivo?.key) {
    return { executionId, bolna: 'already', plivo: 'already' };
  }

  const { bolnaUrl, plivo } = await resolveCallRecordingSources(executionId);
  const plivoUrl = plivo[0]?.recordingUrl || null;

  const results = await Promise.allSettled([
    archiveOne({ executionId, existing: existing.bolna, kind: 'bolna', url: bolnaUrl, force }),
    archiveOne({ executionId, existing: existing.plivo, kind: 'plivo', url: plivoUrl, force }),
  ]);

  const set = {};
  const summary = { executionId, bolna: 'no_source', plivo: 'no_source' };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { kind, status, entry } = r.value;
      summary[kind] = status;
      if (status === 'archived' && entry) set[`recordingArchive.${kind}`] = entry;
    } else {
      // archiveOne rejected — log, leave that source for a later retry.
      logger.error(`[callRecordingArchive] ${executionId} archive error: ${r.reason?.message || r.reason}`);
      summary._error = true;
    }
  }

  // Stamp the attempt marker on every resolved run (even 0 archived) so the
  // backfill converges and won't reprocess calls that have no recording. Later
  // runs (lazy playback / webhook) still fill a missing per-source key, since
  // archiveOne keys off the stored key, not this timestamp.
  set.recordingArchivedAt = new Date();
  await CallRecord.updateOne({ executionId }, { $set: set });
  return summary;
}

/**
 * Presigned S3 URL for an archived recording, or null if that source was never
 * mirrored. Used by the streaming endpoints to serve the saved copy once the
 * live Bolna/Plivo media has expired.
 *
 * @param {{ recordingArchive?: Object }} record
 * @param {'bolna'|'plivo'} kind
 * @param {number} [expiresIn]
 */
export async function getArchivePlaybackUrl(record, kind, expiresIn = 3600) {
  const key = record?.recordingArchive?.[kind]?.key;
  if (!key) return null;
  try {
    return await generatePresignedDownloadUrl(key, expiresIn);
  } catch (err) {
    logger.error(`[callRecordingArchive] presign failed (${key}): ${err.message}`);
    return null;
  }
}

/** Same as getArchivePlaybackUrl but loads the record by executionId first. */
export async function getArchivedPlaybackUrlByExecution(executionId, kind, expiresIn = 3600) {
  const rec = await CallRecord.findOne({ executionId }).select('recordingArchive');
  if (!rec) return null;
  return getArchivePlaybackUrl(rec, kind, expiresIn);
}

/**
 * Mongo filter for calls that plausibly have a recording but haven't been
 * archived yet. "Not attempted" = `recordingArchivedAt` null. We key on the
 * attempt marker (not per-source keys) so calls that simply have no Plivo
 * recording still converge to done after one Bolna archive — otherwise the
 * never-null `plivo.key` would keep them queued forever. Use --force to revisit
 * already-attempted calls (e.g. to pick up a Plivo recording that landed later).
 */
function unarchivedQuery() {
  return {
    status: { $in: TERMINAL_STATUSES },
    recordingArchivedAt: { $in: [null, undefined] },
    $or: [
      { recordingUrl: { $nin: [null, ''] } },
      { 'telephonyData.provider_call_id': { $nin: [null, ''] } },
    ],
  };
}

/** Count of calls still needing an S3 mirror. */
export async function countUnarchived() {
  return CallRecord.countDocuments(unarchivedQuery());
}

/**
 * One-shot backfill: walk terminal calls that have a recording source and mirror
 * any missing Bolna/Plivo audio to S3. Sequential (gentle on Bolna/Plivo/S3).
 *
 * @param {{ limit?: number, force?: boolean, onProgress?: (p: object) => void }} [opts]
 * @returns {Promise<{ processed: number, bolna: number, plivo: number, errors: number, remaining: number }>}
 */
export async function backfillRecordingsToS3({ limit = Infinity, force = false, onProgress } = {}) {
  if (!config.aws?.bucketName) {
    logger.warn('[callRecordingArchive] AWS_S3_BUCKET_NAME not set — backfill skipped');
    return { processed: 0, bolna: 0, plivo: 0, errors: 0, remaining: 0, skipped: 'no_bucket' };
  }

  // force=true revisits every terminal call with a source; otherwise only the gaps.
  const filter = force
    ? {
        status: { $in: TERMINAL_STATUSES },
        $or: [
          { recordingUrl: { $nin: [null, ''] } },
          { 'telephonyData.provider_call_id': { $nin: [null, ''] } },
        ],
      }
    : unarchivedQuery();

  const cursor = CallRecord.find(filter).sort({ createdAt: 1 }).select('executionId').lean().cursor();
  let processed = 0;
  let bolna = 0;
  let plivo = 0;
  let errors = 0;

  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    if (processed >= limit) break;
    try {
      const s = await archiveCallRecordings(doc.executionId, { force });
      if (s.bolna === 'archived') bolna += 1;
      if (s.plivo === 'archived') plivo += 1;
      if (s._error) errors += 1;
    } catch (err) {
      errors += 1;
      logger.error(`[callRecordingArchive] backfill error (${doc.executionId}): ${err.message}`);
    }
    processed += 1;
    if (onProgress && processed % 10 === 0) onProgress({ processed, bolna, plivo, errors });
  }
  await cursor.close();

  const remaining = await CallRecord.countDocuments(unarchivedQuery());
  return { processed, bolna, plivo, errors, remaining };
}

/** Which sources have a saved S3 copy, e.g. { bolna: true, plivo: false }. */
export async function getArchivePresence(executionId) {
  const rec = await CallRecord.findOne({ executionId }).select('recordingArchive');
  return {
    bolna: Boolean(rec?.recordingArchive?.bolna?.key),
    plivo: Boolean(rec?.recordingArchive?.plivo?.key),
  };
}

export default {
  headersForRecordingUrl,
  resolveCallRecordingSources,
  archiveCallRecordings,
  getArchivePlaybackUrl,
  getArchivedPlaybackUrlByExecution,
  getArchivePresence,
  countUnarchived,
  backfillRecordingsToS3,
};
