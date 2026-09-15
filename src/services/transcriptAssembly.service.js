import crypto from 'crypto';
import TranscriptSession from '../models/transcriptSession.model.js';
import TranscriptBatch from '../models/transcriptBatch.model.js';
import TranscriptVersion from '../models/transcriptVersion.model.js';
import Recording, { isRecordingTerminal } from '../models/recording.model.js';
import { uploadJsonToS3 } from './aiArtifactStorage.service.js';
import { buildSummaryJobIdFromVersion } from '../queues/summaryQueue.js';
import logger from '../config/logger.js';

export const SUPPORTED_TRANSCRIPT_LANGUAGES = ['en'];

export function buildTranscriptOwnerKey({ interviewId, meetingId }) {
  if (interviewId) return `interview-${String(interviewId)}`;
  return `meeting-${String(meetingId)}`;
}

export function buildTranscriptVersionS3Key({ ownerKey, version, interviewId, meetingId }) {
  if (interviewId) {
    return `interviews/${String(interviewId)}/transcripts/v${version}.json`;
  }
  const mid = meetingId || ownerKey.replace(/^meeting-/, '');
  return `meetings/${mid}/transcripts/v${version}.json`;
}

export function canonicalUtteranceForHash(u) {
  return {
    utteranceId: u.utteranceId,
    participantIdentity: u.participantIdentity,
    displayName: u.displayName || '',
    text: u.text || '',
    startedAtEpochMs: u.startedAtEpochMs,
    endedAtEpochMs: u.endedAtEpochMs,
    recordingOffsetMs: u.recordingOffsetMs ?? null,
    speakerRole: u.speakerRole || 'unknown',
    roleAssurance: u.roleAssurance || null,
  };
}

export function computeTranscriptContentHash(utterances) {
  const canonical = utterances.map(canonicalUtteranceForHash);
  const body = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(body).digest('hex');
}

export function dedupeAndSortUtterances(batchRows) {
  const byId = new Map();
  for (const batch of batchRows) {
    for (const u of batch.utterances || []) {
      if (!u?.utteranceId) continue;
      if (!byId.has(u.utteranceId)) byId.set(u.utteranceId, u);
    }
  }
  return [...byId.values()].sort((a, b) => (a.startedAtEpochMs || 0) - (b.startedAtEpochMs || 0));
}

export function recordingOffsetForUtterance(recording, startedAtEpochMs) {
  if (!recording || startedAtEpochMs == null) return null;
  const base =
    recording.egressFileStartedAtEpochMs ??
    recording.egressStartedAtEpochMs ??
    null;
  if (base == null) return null;
  const offset = startedAtEpochMs - base;
  return offset < 0 ? null : offset;
}

export function deriveEvidenceGrade({ sessions, recordings, utterances, interviewLanguage }) {
  const reasons = [];
  if (sessions.some((s) => s.partial)) reasons.push('partial_session');
  if (recordings.some((r) => r.truncatedAtScheduleEnd)) reasons.push('truncated_at_schedule_end');
  const lang = interviewLanguage || 'en';
  if (!SUPPORTED_TRANSCRIPT_LANGUAGES.includes(lang)) reasons.push('unsupported_language');

  let maxGapMs = 0;
  for (let i = 1; i < utterances.length; i += 1) {
    const gap = (utterances[i].startedAtEpochMs || 0) - (utterances[i - 1].endedAtEpochMs || 0);
    if (gap > maxGapMs) maxGapMs = gap;
  }
  if (maxGapMs > 2 * 60 * 1000) reasons.push('coverage_gap');

  if (reasons.includes('unsupported_language')) {
    return { evidenceGrade: 'unsupported_language', partialReasons: reasons };
  }
  if (reasons.includes('truncated_at_schedule_end')) {
    return { evidenceGrade: 'truncated', partialReasons: reasons };
  }
  if (reasons.some((r) => r === 'partial_session' || r === 'coverage_gap')) {
    return { evidenceGrade: 'partial', partialReasons: reasons };
  }
  return { evidenceGrade: 'full', partialReasons: reasons };
}

async function recordingsForOwner({ interviewId, meetingId }) {
  if (interviewId) {
    return Recording.find({ interviewId }).lean();
  }
  return Recording.find({ meetingId }).lean();
}

async function sessionsForRecordings(recordingIds) {
  if (!recordingIds.length) return [];
  return TranscriptSession.find({ recordingId: { $in: recordingIds } }).lean();
}

export async function ownerReadyForAssembly({ ownerKey, interviewId, meetingId }) {
  const recordings = await recordingsForOwner({ interviewId, meetingId });
  if (!recordings.length) return { ready: false, reason: 'no_recordings' };
  if (!recordings.every((r) => isRecordingTerminal(r.status))) {
    return { ready: false, reason: 'recordings_not_terminal' };
  }
  const recordingIds = recordings.map((r) => r._id);
  const sessions = await sessionsForRecordings(recordingIds);
  if (!sessions.length) return { ready: false, reason: 'no_sessions' };
  const terminalSession = new Set(['finalized', 'summary_queued', 'completed', 'failed']);
  if (!sessions.every((s) => terminalSession.has(s.status))) {
    return { ready: false, reason: 'sessions_not_finalized' };
  }
  return { ready: true, recordings, sessions };
}

export async function assembleTranscriptVersionForOwner({
  ownerKey,
  interviewId,
  meetingId,
  recordings,
  sessions,
}) {
  const sessionIds = sessions.map((s) => s._id);
  const batches = await TranscriptBatch.find({ sessionId: { $in: sessionIds } })
    .sort({ batchSeq: 1 })
    .lean();
  const raw = dedupeAndSortUtterances(batches);
  if (!raw.length) {
    return { skipped: true, reason: 'no_utterances' };
  }

  const recordingById = new Map(recordings.map((r) => [String(r._id), r]));
  const utterances = raw.map((u) => {
    const rec = u.recordingId ? recordingById.get(String(u.recordingId)) : recordings[0];
    const recordingOffsetMs = recordingOffsetForUtterance(rec, u.startedAtEpochMs);
    return {
      ...canonicalUtteranceForHash({
        ...u,
        speakerRole: u.speakerRole,
        roleAssurance: u.roleAssurance,
        recordingOffsetMs,
      }),
      confidence: u.confidence ?? null,
      recordingId: rec?._id ? String(rec._id) : null,
    };
  });

  const contentHash = computeTranscriptContentHash(utterances);
  const latest = await TranscriptVersion.findOne({ ownerKey }).sort({ version: -1 }).lean();
  if (latest?.contentHash === contentHash) {
    return {
      skipped: true,
      reason: 'unchanged',
      version: latest.version,
      transcriptVersionId: latest._id,
      s3Key: latest.s3Key,
      summaryJobId: buildSummaryJobIdFromVersion({ ownerKey, version: latest.version }),
    };
  }

  const nextVersion = (latest?.version || 0) + 1;
  const s3Key = buildTranscriptVersionS3Key({ ownerKey, version: nextVersion, interviewId, meetingId });
  const interviewLanguage = sessions[0]?.interviewLanguage || 'en';
  const grade = deriveEvidenceGrade({ sessions, recordings, utterances: raw, interviewLanguage });

  const payload = {
    schemaVersion: 1,
    ownerKey,
    interviewId: interviewId ? String(interviewId) : null,
    meetingId: meetingId || null,
    version: nextVersion,
    sessionIds: sessionIds.map((id) => String(id)),
    utteranceCount: utterances.length,
    interviewLanguage,
    evidenceGrade: grade.evidenceGrade,
    partialReasons: grade.partialReasons,
    utterances,
  };

  await uploadJsonToS3({ key: s3Key, data: payload });

  const doc = await TranscriptVersion.create({
    ownerKey,
    interviewId: interviewId || null,
    meetingId: meetingId || null,
    version: nextVersion,
    sessionIds,
    s3Key,
    contentHash,
    utteranceCount: utterances.length,
    evidenceGrade: grade.evidenceGrade,
    partialReasons: grade.partialReasons,
    schemaVersion: 1,
  });

  return {
    skipped: false,
    version: nextVersion,
    transcriptVersionId: doc._id,
    s3Key,
    summaryJobId: buildSummaryJobIdFromVersion({ ownerKey, version: nextVersion }),
    evidenceGrade: grade.evidenceGrade,
  };
}

export async function assembleAndPlanSummaryJob({ session, dispatch }) {
  const interviewId = session.interviewId || null;
  const meetingId = dispatch.meetingId;
  const ownerKey = buildTranscriptOwnerKey({ interviewId, meetingId });
  const readiness = await ownerReadyForAssembly({ ownerKey, interviewId, meetingId });
  if (!readiness.ready) {
    logger.info('[TranscriptAssembly] not ready', { ownerKey, reason: readiness.reason });
    return { ready: false, reason: readiness.reason };
  }

  const assembly = await assembleTranscriptVersionForOwner({
    ownerKey,
    interviewId,
    meetingId,
    recordings: readiness.recordings,
    sessions: readiness.sessions,
  });

  if (assembly.skipped && assembly.reason === 'no_utterances') {
    return { ready: false, reason: 'no_utterances' };
  }

  return {
    ready: true,
    ownerKey,
    transcriptVersionId: assembly.transcriptVersionId,
    summaryJobId: assembly.summaryJobId,
    s3Key: assembly.s3Key,
    version: assembly.version,
  };
}
