import { EgressStatus } from 'livekit-server-sdk';
import mongoose from 'mongoose';
import Recording, { recordingRank } from '../models/recording.model.js';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import { generatePresignedRecordingPlaybackUrl, headRecordingObject } from '../config/s3.js';
import { getEgressClient } from './livekit.service.js';
import { recordingScope } from './visibilityScope.service.js';
import { resolveTenantIdForMeeting } from './recordingSync.service.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import logger from '../config/logger.js';

/**
 * Convert LiveKit timestamp (ns bigint/string, ms number, or seconds) to ms epoch.
 */
const tsToMs = (v) => {
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
  if (n >= 1e16) return Math.floor(n / 1e6); // ns
  if (n >= 1e10) return Math.floor(n);       // ms
  return Math.floor(n * 1000);               // seconds
};

const PLAYBACK_URL_EXPIRY_SECONDS = 3600; // 1 hour
const LISTABLE_STATUSES = ['recording', 'stopping', 'finalizing', 'completed', 'aborted', 'failed', 'expired'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mergeQuery = (scopeFilter = {}, query = {}) => {
  if (!scopeFilter || !Object.keys(scopeFilter).length) return query;
  if (!query || !Object.keys(query).length) return scopeFilter;
  return { $and: [scopeFilter, query] };
};

/**
 * Resolve meeting identifier to meetingId (roomName) for Recording queries.
 * @param {string} id - Meeting _id (MongoDB ObjectId) or meetingId string
 * @returns {Promise<string>} meetingId (roomName)
 */
const resolveMeetingId = async (id) => {
  if (!id) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Meeting id is required');
  }
  if (/^[a-fA-F0-9]{24}$/.test(id)) {
    const meeting = await Meeting.findById(id);
    if (meeting) return meeting.meetingId;
    const internal = await InternalMeeting.findById(id);
    if (internal) return internal.meetingId;
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const meeting = await Meeting.findOne({ meetingId: id });
  if (meeting) return id;
  const internal = await InternalMeeting.findOne({ meetingId: id });
  if (internal) return id;
  throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
};

/**
 * List recordings for a meeting with signed playback URLs (completed only).
 * @param {string} meetingIdOrMongoId - Meeting id (MongoDB _id or meetingId string)
 * @returns {Promise<Array<{ id, meetingId, egressId, filePath, status, startedAt, completedAt, playbackUrl }>>}
 */
const listByMeetingId = async (meetingIdOrMongoId) => {
  const meetingId = await resolveMeetingId(meetingIdOrMongoId);
  const recordings = await Recording.find({ meetingId, status: { $ne: 'missing' } })
    .sort({ startedAt: -1 })
    .lean();

  const result = [];
  for (const rec of recordings) {
    // Sanity-cap durationMs. Old webhook bug stored completedAt as ns*1000
    // (year 58000+), making completedAt - startedAt overflow into hundreds of
    // hours. Anything > MAX_REASONABLE is bogus → null.
    const MAX_REASONABLE_MS = 24 * 60 * 60 * 1000; // 24 hours
    let durationMs = rec.durationMs ?? null;
    if (durationMs == null && rec.startedAt && rec.completedAt) {
      const ms = new Date(rec.completedAt).getTime() - new Date(rec.startedAt).getTime();
      if (Number.isFinite(ms) && ms >= 0) durationMs = ms;
    }
    if (durationMs != null && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_REASONABLE_MS)) {
      durationMs = null;
    }
    const item = {
      id: rec._id?.toString(),
      meetingId: rec.meetingId,
      egressId: rec.egressId,
      filePath: rec.filePath,
      status: rec.status,
      startedAt: rec.startedAt,
      completedAt: rec.completedAt,
      durationMs,
      bytes: rec.bytes ?? null,
    };
    // Generate playback URL for any row that has a real S3 file, even if status
    // is `aborted` — LiveKit may have flushed partial bytes before terminating
    // and the user can still recover something. Frontend shows a warning badge.
    const hasPotentialFile =
      rec.filePath && (rec.status === 'completed' || rec.status === 'aborted');
    if (hasPotentialFile) {
      try {
        item.playbackUrl = await generatePresignedRecordingPlaybackUrl(
          rec.filePath,
          PLAYBACK_URL_EXPIRY_SECONDS
        );
      } catch (err) {
        item.playbackUrl = null;
        item.playbackError = err.message || 'Failed to generate playback URL';
      }
    }
    // Surface the LiveKit error so ops can see WHY a row is aborted/failed/missing.
    if (['aborted', 'failed', 'missing'].includes(rec.status) && rec.lastError) {
      item.lastError = rec.lastError;
    }
    result.push(item);
  }
  return result;
};

/**
 * List all recordings (paginated) with meeting title. For Recordings page.
 * @param {Object} options - { page, limit }
 * @returns {Promise<{ results, page, limit, totalPages, totalResults }>}
 */
const listAll = async (options = {}, currentUser = {}) => {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const q = String(options.q || '').trim();
  const dateFrom = options.dateFrom ? new Date(options.dateFrom) : null;
  const dateTo = options.dateTo ? new Date(options.dateTo) : null;
  // 'interview' | 'meeting' | '' (all)
  const sourceFilter = String(options.source || '').trim().toLowerCase();
  const statusFilter = String(options.status || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selectedStatuses = statusFilter.length
    ? statusFilter.filter((s) => LISTABLE_STATUSES.includes(s))
    : LISTABLE_STATUSES;
  if (!selectedStatuses.length) {
    return { results: [], page, limit, totalPages: 0, totalResults: 0 };
  }

  const { filter: scopeFilter } = await recordingScope(currentUser, 'read');
  if (scopeFilter?._id?.$in && scopeFilter._id.$in.length === 0) {
    return { results: [], page, limit, totalPages: 0, totalResults: 0 };
  }

  // Show every meaningful row so ops can see WHAT happened, not just clean
  // completions. Frontend differentiates by `status`:
  //   recording/stopping/finalizing → live badge
  //   completed                     → playback link
  //   aborted/failed                  → red "Recording failed" badge with reason
  // `missing` and `expired` are hidden from list APIs — no playback and noisy for users.
  const query = { status: { $in: selectedStatuses } };
  if (dateFrom || dateTo) {
    query.startedAt = {};
    if (dateFrom && !Number.isNaN(dateFrom.getTime())) query.startedAt.$gte = dateFrom;
    if (dateTo && !Number.isNaN(dateTo.getTime())) query.startedAt.$lte = dateTo;
  }

  // For source/attendee search we must first resolve matching meetingIds from
  // the Meeting collection, then filter Recordings by those meetingIds.
  let searchRestrictedMeetingIds = null; // null = no restriction; [] = no results
  if (q || sourceFilter) {
    const qRegex = q ? new RegExp(escapeRegex(q), 'i') : null;

    // Build Meeting-level query for title + attendee name/email search
    const meetingConditions = [];
    if (qRegex) {
      meetingConditions.push(
        { title: qRegex },
        { 'candidate.name': qRegex },
        { 'candidate.email': qRegex },
        { 'recruiter.name': qRegex },
        { 'recruiter.email': qRegex },
        { 'hosts.nameOrRole': qRegex },
        { 'hosts.email': qRegex },
        { 'agents.name': qRegex },
        { 'agents.email': qRegex },
        { emailInvites: qRegex }
      );
    }

    // Source filter: interviews have a candidate.id or jobPosition set; plain
    // meetings do not.
    const sourceCondition =
      sourceFilter === 'interview'
        ? { $or: [{ 'candidate.id': { $exists: true, $ne: '' } }, { jobPosition: { $exists: true, $ne: '' } }] }
        : sourceFilter === 'meeting'
        ? { 'candidate.id': { $in: [null, undefined, ''] }, jobPosition: { $in: [null, undefined, ''] } }
        : null;

    const combinedMeetingQuery = {};
    if (qRegex && meetingConditions.length) combinedMeetingQuery.$or = meetingConditions;
    if (sourceCondition) Object.assign(combinedMeetingQuery, sourceCondition);

    // Also match recordings directly by meetingId (room name) when free-text is present
    const directIdMatchMeetingIds = qRegex
      ? (await Recording.find({ meetingId: qRegex }, { meetingId: 1 }).lean()).map((r) => r.meetingId)
      : [];

    const [matchedMeetings] = await Promise.all([
      Meeting.find(combinedMeetingQuery, { meetingId: 1 }).limit(500).lean(),
    ]);
    const matchedIds = new Set([
      ...matchedMeetings.map((m) => m.meetingId),
      ...directIdMatchMeetingIds,
    ]);

    searchRestrictedMeetingIds = [...matchedIds];
    if (searchRestrictedMeetingIds.length === 0) {
      return { results: [], page, limit, totalPages: 0, totalResults: 0 };
    }
    query.meetingId = { $in: searchRestrictedMeetingIds };
  }

  const scopedQuery = mergeQuery(scopeFilter, query);
  const [recordings, total] = await Promise.all([
    Recording.find(scopedQuery)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Recording.countDocuments(scopedQuery),
  ]);

  const meetingIds = [...new Set(recordings.map((r) => r.meetingId))];
  const [meetings, internalMeetings] = await Promise.all([
    Meeting.find({ meetingId: { $in: meetingIds } })
      .select('meetingId title candidate recruiter hosts emailInvites agents jobPosition')
      .lean(),
    InternalMeeting.find({ meetingId: { $in: meetingIds } })
      .select('meetingId title')
      .lean(),
  ]);
  const meetingMap = Object.fromEntries([
    ...meetings.map((m) => [m.meetingId, m]),
    ...internalMeetings.map((m) => [m.meetingId, m]),
  ]);

  const result = [];
  for (const rec of recordings) {
    // Sanity-cap durationMs. Old webhook bug stored completedAt as ns*1000
    // (year 58000+), making completedAt - startedAt overflow into hundreds of
    // hours. Anything > MAX_REASONABLE is bogus → null.
    const MAX_REASONABLE_MS = 24 * 60 * 60 * 1000; // 24 hours
    let durationMs = rec.durationMs ?? null;
    if (durationMs == null && rec.startedAt && rec.completedAt) {
      const ms = new Date(rec.completedAt).getTime() - new Date(rec.startedAt).getTime();
      if (Number.isFinite(ms) && ms >= 0) durationMs = ms;
    }
    if (durationMs != null && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_REASONABLE_MS)) {
      durationMs = null;
    }
    const mtg = meetingMap[rec.meetingId];
    // Detect whether this recording came from an interview or a plain meeting.
    // Interviews always have a candidate.id or a jobPosition set on the Meeting
    // document; plain scheduled meetings do not.
    const isInterview = !!(
      mtg &&
      ((mtg.candidate?.id && String(mtg.candidate.id).trim()) ||
        (mtg.jobPosition && String(mtg.jobPosition).trim()))
    );

    // Build a flat attendee list: candidate + recruiter + hosts + agents + emailInvites.
    const attendees = [];
    if (mtg) {
      if (mtg.candidate?.name || mtg.candidate?.email) {
        attendees.push({ name: mtg.candidate.name || null, email: mtg.candidate.email || null, role: 'candidate' });
      }
      if (mtg.recruiter?.name || mtg.recruiter?.email) {
        attendees.push({ name: mtg.recruiter.name || null, email: mtg.recruiter.email || null, role: 'recruiter' });
      }
      for (const h of mtg.hosts || []) {
        if (h.email) attendees.push({ name: h.nameOrRole || null, email: h.email, role: 'host' });
      }
      for (const a of mtg.agents || []) {
        if (a.email) attendees.push({ name: a.name || null, email: a.email, role: 'agent' });
      }
      for (const email of mtg.emailInvites || []) {
        if (email) attendees.push({ name: null, email, role: 'invite' });
      }
    }

    const item = {
      id: rec._id?.toString(),
      meetingId: rec.meetingId,
      meetingTitle: mtg?.title || rec.meetingId,
      source: isInterview ? 'interview' : 'meeting',
      attendees,
      egressId: rec.egressId,
      filePath: rec.filePath,
      status: rec.status,
      startedAt: rec.startedAt,
      completedAt: rec.completedAt,
      durationMs,
      bytes: rec.bytes ?? null,
      aiProcessingStatus: rec.aiProcessingStatus ?? 'none',
      aiProcessingError: rec.aiProcessingError ?? null,
      summaryId: rec.summaryId ?? null,
      transcriptUrl: rec.transcriptUrl ?? null,
      summaryUrl: rec.summaryUrl ?? null,
    };
    // Generate playback URL for any row that has a real S3 file, even if status
    // is `aborted` — LiveKit may have flushed partial bytes before terminating
    // and the user can still recover something. Frontend shows a warning badge.
    const hasPotentialFile =
      rec.filePath && (rec.status === 'completed' || rec.status === 'aborted');
    if (hasPotentialFile) {
      try {
        item.playbackUrl = await generatePresignedRecordingPlaybackUrl(
          rec.filePath,
          PLAYBACK_URL_EXPIRY_SECONDS
        );
      } catch (err) {
        item.playbackUrl = null;
        item.playbackError = err.message || 'Failed to generate playback URL';
      }
    }
    // Surface the LiveKit error so ops can see WHY a row is aborted/failed/missing.
    if (['aborted', 'failed', 'missing'].includes(rec.status) && rec.lastError) {
      item.lastError = rec.lastError;
    }
    result.push(item);
  }

  return {
    results: result,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    totalResults: total,
  };
};

/**
 * Simple sync: pull every egress from LiveKit, upsert Recording rows so the DB
 * matches LiveKit truth. Idempotent — safe to run as often as you want.
 *
 *   - EGRESS_COMPLETE  + S3 file present  → upsert as `completed`
 *   - EGRESS_COMPLETE  + S3 missing/empty → upsert as `missing`
 *   - EGRESS_ABORTED                      → upsert as `aborted`
 *   - EGRESS_FAILED / EGRESS_LIMIT_REACHED → upsert as `failed`
 *   - in-progress (STARTING/ACTIVE/ENDING) → upsert as `recording`/`stopping`
 *
 * `meetingId` on the Recording row is set from `egressInfo.roomName`. If we
 * have a Meeting / InternalMeeting with that meetingId, the row will surface
 * via `listByMeetingId`. If not, the row still appears in `listAll` for ops.
 */
const syncFromLiveKit = async () => {
  const egressClient = getEgressClient();
  if (!egressClient) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'LiveKit egress client not initialized');
  }

  // Pull all egresses LiveKit still retains. Use both filters to maximize coverage.
  const seen = new Map();
  for (const filter of [{}, { active: false }]) {
    let list = [];
    try {
      list = await egressClient.listEgress(filter);
    } catch (err) {
      logger.warn(`[Recording sync] listEgress(${JSON.stringify(filter)}) failed: ${err.message}`);
      continue;
    }
    for (const info of list || []) {
      const id = info.egressId || info.egress_id;
      if (id && !seen.has(id)) seen.set(id, info);
    }
  }

  let upserted = 0;
  let skipped = 0;
  const results = [];

  for (const [egressId, info] of seen) {
    // LiveKit JS SDK returns info.status as either a string ("EGRESS_COMPLETE")
    // or a numeric enum (3) depending on version. Accept BOTH at every check —
    // previous numeric-only comparison silently failed on string returns and
    // left rows stuck on `recording`.
    const statusStr = typeof info.status === 'string' ? info.status : null;
    const statusNum = Number(info.status);
    const isStarting = statusStr === 'EGRESS_STARTING'      || statusNum === 0;
    const isActive   = statusStr === 'EGRESS_ACTIVE'        || info.status === EgressStatus.EGRESS_ACTIVE        || statusNum === 1;
    const isEnding   = statusStr === 'EGRESS_ENDING'        || info.status === EgressStatus.EGRESS_ENDING        || statusNum === 2;
    const isComplete = statusStr === 'EGRESS_COMPLETE'      || info.status === EgressStatus.EGRESS_COMPLETE      || statusNum === 3;
    const isFailed   = statusStr === 'EGRESS_FAILED'        || info.status === EgressStatus.EGRESS_FAILED        || statusNum === 4;
    const isAborted  = statusStr === 'EGRESS_ABORTED'       || info.status === EgressStatus.EGRESS_ABORTED       || statusNum === 5;
    const isLimit    = statusStr === 'EGRESS_LIMIT_REACHED' || info.status === EgressStatus.EGRESS_LIMIT_REACHED || statusNum === 6;

    const fr = info.fileResults || info.file_results || info.fileResultsList;
    // Some SDK / API versions return file output via the legacy singular
    // `file` (or oneof `result.file`) instead of the `file_results` array.
    // Without these fallbacks, listEgress sweeps would mark every row as
    // "EGRESS_COMPLETE without filePath" and stuff them into `missing`.
    const f0 = fr?.[0] || info.files?.[0] || info.file || info.result?.file || info.result?.value || {};
    const filePath = f0.filename || f0.filepath || f0.location || null;
    const bytesFromEgress = Number(f0.size || f0.bytes || 0) || null;
    const fileDurationMs = tsToMs(f0.duration ?? f0.durationNs);

    const meetingId = info.roomName || info.room_name || 'unknown';
    const startedAt = tsToMs(info.startedAt ?? info.started_at);
    const endedAt = tsToMs(info.endedAt ?? info.ended_at);

    // Resolve target status.
    let targetStatus;
    let s3Verified = null;
    let lastError = null;
    let resolvedFilePath = filePath;
    const errCtx = [
      info.error || info.errorMessage,
      (info.errorCode ?? info.error_code) != null ? `code=${info.errorCode ?? info.error_code}` : null,
      info.details,
    ].filter(Boolean).join(' | ') || null;

    if (isAborted) {
      targetStatus = 'aborted';
      lastError = ['EGRESS_ABORTED', errCtx].filter(Boolean).join(' :: ');
    } else if (isFailed || isLimit) {
      targetStatus = 'failed';
      lastError = [isFailed ? 'EGRESS_FAILED' : 'EGRESS_LIMIT_REACHED', errCtx].filter(Boolean).join(' :: ');
    } else if (isComplete) {
      // LiveKit's listEgress sometimes returns EgressInfo without fileResults
      // (varies by SDK version, retention age, and direct vs. composite egress).
      // Fall back to the predicted S3 key the row carries from attachEgressId,
      // otherwise EGRESS_COMPLETE rows would all go to `missing` even though
      // the file is sitting in S3.
      let probeKey = filePath;
      if (!probeKey) {
        const known = await Recording.findOne({ egressId }).select('filePath').lean();
        probeKey = known?.filePath || null;
      }
      if (probeKey) {
        s3Verified = await headRecordingObject(probeKey);
        if (s3Verified.ok && (s3Verified.size || bytesFromEgress || 0) > 0) {
          targetStatus = 'completed';
          resolvedFilePath = probeKey;
        } else {
          targetStatus = 'missing';
          lastError = s3Verified.ok ? 'EGRESS_COMPLETE but zero bytes in S3' : `EGRESS_COMPLETE but S3 unreachable: ${s3Verified.error}`;
        }
      } else {
        targetStatus = 'missing';
        lastError = 'EGRESS_COMPLETE without filePath (and no predicted key on existing row)';
      }
    } else if (isEnding) {
      targetStatus = 'stopping';
    } else if (isActive || isStarting) {
      targetStatus = 'recording';
    } else {
      skipped += 1;
      continue;
    }

    // Build the patch — only include real values so we don't clobber existing data.
    const patch = {
      status: targetStatus,
      statusRank: recordingRank(targetStatus),
      meetingId,
    };
    if (resolvedFilePath) patch.filePath = resolvedFilePath;
    if (s3Verified?.ok && s3Verified.bucket) {
      patch.s3Bucket = s3Verified.bucket;
      patch.s3Key = s3Verified.key || filePath;
    }
    const finalBytes = s3Verified?.size || bytesFromEgress || null;
    if (finalBytes) patch.bytes = finalBytes;
    if (startedAt) patch.startedAt = new Date(startedAt);
    if (endedAt) patch.completedAt = new Date(endedAt);
    if (fileDurationMs) patch.durationMs = fileDurationMs;
    else if (startedAt && endedAt) patch.durationMs = Math.max(0, endedAt - startedAt);
    if (lastError) patch.lastError = lastError;

    // Look up by egressId, then either update existing row by _id (avoiding
    // the upsert+11000 dance that previously masked failures) or insert a new
    // row. Monotonic guard: only overwrite if new rank >= existing rank. Treat
    // missing statusRank as 0 — legacy rows from before the field existed
    // must not be excluded, otherwise `recording` rows stay stuck forever.
    const existing = await Recording.findOne({ egressId })
      .select('_id status statusRank meetingId filePath bytes tenantId')
      .lean();

    let r = null;
    if (existing) {
      const existingRank = Number.isFinite(existing.statusRank) ? existing.statusRank : 0;
      if (existingRank <= patch.statusRank) {
        // Backfill tenantId on existing rows that pre-date tenant stamping.
        if (!existing.tenantId) {
          const tid = await resolveTenantIdForMeeting(meetingId);
          if (tid) patch.tenantId = tid;
        }
        await Recording.updateOne({ _id: existing._id }, { $set: patch });
        r = await Recording.findById(existing._id).lean();
      } else {
        r = existing;
      }
    } else {
      try {
        const tid = await resolveTenantIdForMeeting(meetingId);
        const created = await Recording.create({ ...patch, egressId, ...(tid ? { tenantId: tid } : {}) });
        r = created.toObject ? created.toObject() : created;
      } catch (err) {
        if (err.code === 11000) {
          const raced = await Recording.findOne({ egressId }).lean();
          if (raced) {
            const racedRank = Number.isFinite(raced.statusRank) ? raced.statusRank : 0;
            if (racedRank <= patch.statusRank) {
              if (!raced.tenantId) {
                const tid = await resolveTenantIdForMeeting(meetingId);
                if (tid) patch.tenantId = tid;
              }
              await Recording.updateOne({ _id: raced._id }, { $set: patch });
              r = await Recording.findById(raced._id).lean();
            } else {
              r = raced;
            }
          }
        } else {
          throw err;
        }
      }
    }

    if (r) {
      upserted += 1;
      results.push({
        egressId,
        meetingId,
        status: r.status,
        livekitStatus: info.status,
        filePath: r.filePath,
        bytes: r.bytes,
      });
    } else {
      skipped += 1;
    }
  }

  // Phase 2: backfill DB rows stuck in non-terminal status that LiveKit's
  // listEgress sweep didn't return (egress retention may have purged them).
  // Resolve each via per-egressId lookup or, failing that, S3 HEAD on the
  // predicted filePath set during startRecording.
  const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // anything stuck >2 min
  const stuck = await Recording.find({
    status: { $in: ['pending', 'recording', 'stopping', 'finalizing'] },
    startedAt: { $lt: new Date(Date.now() - STUCK_THRESHOLD_MS) },
  })
    .limit(500)
    .lean();

  let backfilled = 0;
  let stuckSkipped = 0;
  for (const rec of stuck) {
    if (rec.egressId && seen.has(rec.egressId)) {
      // Already handled in Phase 1 sweep above.
      continue;
    }
    try {
      // Try direct egressId lookup first.
      let info = null;
      if (rec.egressId) {
        try {
          const direct = await egressClient.listEgress({ egressId: rec.egressId });
          info = direct?.[0] || null;
        } catch {
          info = null;
        }
      }

      if (info) {
        const sNum = Number(info.status);
        const sStr = typeof info.status === 'string' ? info.status : null;
        const isCpl = sStr === 'EGRESS_COMPLETE' || info.status === EgressStatus.EGRESS_COMPLETE || sNum === 3;
        const isFld = sStr === 'EGRESS_FAILED' || info.status === EgressStatus.EGRESS_FAILED || sNum === 4;
        const isAbt = sStr === 'EGRESS_ABORTED' || info.status === EgressStatus.EGRESS_ABORTED || sNum === 5;
        const isLmt = sStr === 'EGRESS_LIMIT_REACHED' || info.status === EgressStatus.EGRESS_LIMIT_REACHED || sNum === 6;
        const fr = info.fileResults || info.file_results || info.fileResultsList;
        const f0 = fr?.[0] || info.files?.[0] || info.file || info.result?.file || info.result?.value || {};
        const fp = f0.filename || f0.filepath || f0.location || null;
        const fpBytes = Number(f0.size || f0.bytes || 0) || null;
        const endedAt = tsToMs(info.endedAt ?? info.ended_at);

        let nextStatus = null;
        let patchExtra = {};
        if (isAbt) {
          nextStatus = 'aborted';
          patchExtra.lastError = 'Backfilled from LiveKit: EGRESS_ABORTED';
        } else if (isFld || isLmt) {
          nextStatus = 'failed';
          patchExtra.lastError = `Backfilled from LiveKit: ${isFld ? 'EGRESS_FAILED' : 'EGRESS_LIMIT_REACHED'}`;
        } else if (isCpl && fp) {
          const v = await headRecordingObject(fp);
          if (v.ok && (v.size || fpBytes || 0) > 0) {
            nextStatus = 'completed';
            patchExtra = { filePath: fp, s3Bucket: v.bucket, s3Key: v.key, bytes: v.size || fpBytes };
          } else {
            nextStatus = 'missing';
            patchExtra.lastError = v.ok ? 'Backfill: COMPLETE but zero bytes' : `Backfill: S3 unreachable: ${v.error}`;
            patchExtra.filePath = fp;
          }
        } else if (isCpl && !fp) {
          nextStatus = 'missing';
          patchExtra.lastError = 'Backfill: COMPLETE without filePath';
        }

        if (nextStatus) {
          // Treat missing/null statusRank as 0 so legacy rows aren't excluded.
          const filter = {
            _id: rec._id,
            $or: [
              { statusRank: { $lte: recordingRank(nextStatus) } },
              { statusRank: { $exists: false } },
              { statusRank: null },
            ],
          };
          await Recording.updateOne(filter, {
            $set: {
              status: nextStatus,
              statusRank: recordingRank(nextStatus),
              completedAt: endedAt ? new Date(endedAt) : new Date(),
              ...patchExtra,
            },
          });
          backfilled += 1;
          logger.info(`[Recording sync] backfilled stuck row egressId=${rec.egressId} → ${nextStatus}`);
          continue;
        }
      }

      // No info from LiveKit (egress purged or never had egressId). Fall back
      // to S3 HEAD on the predicted filePath set at startRecording time.
      if (rec.filePath) {
        const v = await headRecordingObject(rec.filePath);
        if (v.ok && v.size > 0) {
          await Recording.updateOne(
            {
              _id: rec._id,
              $or: [
                { statusRank: { $lte: recordingRank('completed') } },
                { statusRank: { $exists: false } },
                { statusRank: null },
              ],
            },
            {
              $set: {
                status: 'completed',
                statusRank: recordingRank('completed'),
                completedAt: rec.completedAt || new Date(),
                s3Bucket: v.bucket,
                s3Key: v.key,
                bytes: v.size,
              },
            }
          );
          backfilled += 1;
          logger.info(`[Recording sync] backfilled via S3 HEAD egressId=${rec.egressId} bytes=${v.size}`);
          continue;
        }
        // S3 has no file: mark missing if old enough (>30 min old likely never finalized).
        const ageMs = Date.now() - new Date(rec.startedAt).getTime();
        if (ageMs > 30 * 60 * 1000) {
          await Recording.updateOne(
            {
              _id: rec._id,
              $or: [
                { statusRank: { $lte: recordingRank('missing') } },
                { statusRank: { $exists: false } },
                { statusRank: null },
              ],
            },
            {
              $set: {
                status: 'missing',
                statusRank: recordingRank('missing'),
                completedAt: new Date(),
                lastError: v.ok ? 'Backfill: S3 file zero bytes after 30min' : `Backfill: S3 HEAD failed: ${v.error}`,
              },
            }
          );
          backfilled += 1;
          continue;
        }
      }

      stuckSkipped += 1;
    } catch (err) {
      logger.warn(`[Recording sync] backfill row ${rec._id} failed: ${err?.message || err}`);
      stuckSkipped += 1;
    }
  }

  // Phase 3: re-verify rows previously marked `missing` against S3. The webhook
  // (or earlier cron pass) may have lost the race to LiveKit's S3 upload — the
  // file landed seconds later. Without this resweep, those rows were stuck on
  // `missing` forever even though playback would have succeeded.
  const missingRows = await Recording.find({
    status: 'missing',
    filePath: { $type: 'string', $ne: '' },
  })
    .select('_id egressId filePath bytes s3Bucket s3Key')
    .limit(500)
    .lean();

  let missingResweptOk = 0;
  let missingResweptStillGone = 0;
  for (const rec of missingRows) {
    try {
      const v = await headRecordingObject(rec.filePath);
      if (!v.ok || !v.size || v.size <= 0) {
        missingResweptStillGone += 1;
        continue;
      }
      await Recording.updateOne(
        {
          _id: rec._id,
          // Same monotonic guard idiom as elsewhere — allow promotion since
          // missing and completed share rank 10 (same-rank enrichment).
          $or: [
            { statusRank: { $lte: recordingRank('completed') } },
            { statusRank: { $exists: false } },
            { statusRank: null },
          ],
        },
        {
          $set: {
            status: 'completed',
            statusRank: recordingRank('completed'),
            s3Bucket: v.bucket,
            s3Key: v.key,
            bytes: v.size,
            lastError: null,
          },
        }
      );
      missingResweptOk += 1;
      logger.info(`[Recording sync] missing→completed via S3 resweep egressId=${rec.egressId} bytes=${v.size}`);
    } catch (err) {
      logger.warn(`[Recording sync] missing resweep ${rec._id} failed: ${err?.message || err}`);
      missingResweptStillGone += 1;
    }
  }

  // Cross-link to Meeting / InternalMeeting for ops visibility (informational).
  const meetingIds = [...new Set(results.map((r) => r.meetingId))].filter((m) => m && m !== 'unknown');
  const [meetings, internalMeetings] = await Promise.all([
    Meeting.find({ meetingId: { $in: meetingIds } }).select('meetingId title').lean(),
    InternalMeeting.find({ meetingId: { $in: meetingIds } }).select('meetingId title').lean(),
  ]);
  const meetingMap = Object.fromEntries(
    [...meetings, ...internalMeetings].map((m) => [m.meetingId, m.title])
  );
  for (const r of results) {
    r.meetingTitle = meetingMap[r.meetingId] || null;
    r.matched = !!meetingMap[r.meetingId];
  }

  logger.info(
    `[Recording sync] swept=${seen.size} upserted=${upserted} skipped=${skipped} stuckScanned=${stuck.length} backfilled=${backfilled} missingResweptOk=${missingResweptOk} missingStillGone=${missingResweptStillGone}`
  );
  return {
    swept: seen.size,
    upserted,
    skipped,
    stuckScanned: stuck.length,
    backfilled,
    stuckSkipped,
    missingResweptOk,
    missingResweptStillGone,
    results,
  };
};

/**
 * Fetch transcript segments for a recording. Looks up by `recordingId` first
 * (post Task 9 — direct FK). Falls back to `meetingId` for legacy rows whose
 * segments were ingested before the recordingId link existed.
 *
 * @param {string} recordingId - Mongo ObjectId of the Recording row.
 * @param {Object} [options] - { page, limit }
 * @returns {Promise<{ recording, meetingTitle, segments, totalSegments, page, limit, totalPages, source }>}
 */
const getTranscriptByRecordingId = async (recordingId, currentUser = {}, options = {}) => {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(options.limit, 10) || 50));
  const skip = (page - 1) * limit;

  if (!recordingId || !mongoose.isValidObjectId(recordingId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid recording id');
  }
  // Tenant/ownership scope — mirror listAll() so a user can only read transcripts
  // for recordings they're allowed to see (prevents cross-tenant IDOR by ObjectId).
  const { filter: scopeFilter } = await recordingScope(currentUser, 'read');
  if (scopeFilter?._id?.$in && scopeFilter._id.$in.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recording not found');
  }
  const recording = await Recording.findOne({ _id: recordingId, ...scopeFilter }).lean();
  if (!recording) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recording not found');
  }

  const segmentQuery = { recordingId: recording._id };
  let source = 'recordingId';
  let totalSegments = await TranscriptSegment.countDocuments(segmentQuery);

  if (totalSegments === 0 && recording.meetingId) {
    const legacyQuery = { meetingId: recording.meetingId };
    totalSegments = await TranscriptSegment.countDocuments(legacyQuery);
    if (totalSegments > 0) {
      segmentQuery.meetingId = recording.meetingId;
      delete segmentQuery.recordingId;
      source = 'meetingId';
    }
  }

  const segments = await TranscriptSegment.find(segmentQuery)
    .sort({ sequenceNumber: 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const meeting =
    (await Meeting.findOne({ meetingId: recording.meetingId }).select('meetingId title').lean()) ||
    (await InternalMeeting.findOne({ meetingId: recording.meetingId }).select('meetingId title').lean());

  return {
    recording: {
      id: recording._id?.toString(),
      meetingId: recording.meetingId,
      egressId: recording.egressId,
      status: recording.status,
      startedAt: recording.startedAt,
      completedAt: recording.completedAt,
      durationMs: recording.durationMs ?? null,
      aiProcessingStatus: recording.aiProcessingStatus ?? 'none',
      aiProcessingError: recording.aiProcessingError ?? null,
    },
    meetingTitle: meeting?.title || recording.meetingId,
    segments: segments.map((s) => ({
      id: s._id?.toString(),
      sequenceNumber: s.sequenceNumber,
      windowStartMs: s.windowStartMs,
      windowEndMs: s.windowEndMs,
      combinedText: s.combinedText,
      utteranceCount: s.utteranceCount,
      utterances: (s.utterances || []).map((u) => ({
        speaker: u.speaker ?? null,
        speakerName: u.speakerName ?? null,
        speakerLabel: u.speakerLabel ?? null,
        speakerSource: u.speakerSource ?? null,
        text: u.text,
        startMs: u.startMs,
        endMs: u.endMs,
        confidence: u.confidence ?? null,
      })),
      createdAt: s.createdAt,
    })),
    totalSegments,
    page,
    limit,
    totalPages: Math.ceil(totalSegments / limit) || 1,
    source,
  };
};

export default {
  listByMeetingId,
  listAll,
  resolveMeetingId,
  syncFromLiveKit,
  getTranscriptByRecordingId,
};
