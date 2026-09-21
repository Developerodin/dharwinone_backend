import crypto from 'crypto';

export function utteranceIdsHash(utterances) {
  const ids = utterances.map((u) => u.utteranceId).sort();
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
}

export function computeMissingBatchSeqs(ackedBatchSeqs, storedBatchSeqs) {
  const stored = new Set(storedBatchSeqs);
  const acked = [...new Set(ackedBatchSeqs || [])];
  return acked.filter((seq) => !stored.has(seq)).sort((a, b) => a - b);
}

const TERMINAL_RUN = new Set(['finalized', 'lost']);

export function sessionFinalizeState(runs) {
  if (!runs?.length) return 'waiting';
  const allTerminal = runs.every((r) => TERMINAL_RUN.has(r.status));
  if (!allTerminal) return 'waiting';
  const anyFinalized = runs.some((r) => r.status === 'finalized');
  return anyFinalized ? 'ready' : 'all_lost';
}

export function utterancesFromBatches(batches) {
  const byId = new Map();
  for (const batch of batches) {
    for (const u of batch.utterances || []) {
      if (!byId.has(u.utteranceId)) byId.set(u.utteranceId, u);
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.startedAtEpochMs - b.startedAtEpochMs);
  if (!sorted.length) {
    return { utterances: [], durationMs: 0 };
  }
  const firstStart = sorted[0].startedAtEpochMs;
  const utterances = sorted.map((u) => ({
    speaker: u.participantIdentity,
    speakerName: u.displayName,
    speakerSource: 'livekit',
    text: u.text,
    startMs: u.startedAtEpochMs - firstStart,
    endMs: u.endedAtEpochMs - firstStart,
    confidence: u.confidence,
  }));
  const lastEnd = sorted[sorted.length - 1].endedAtEpochMs;
  return { utterances, durationMs: lastEnd - firstStart };
}

/**
 * Pick the zero point for displayed transcript offsets.
 *
 * `recordingOffsetMs` is added during transcript assembly
 * (transcriptAssembly.service.js), so rows read straight out of TranscriptBatch
 * have never carried it and callers on that path must derive their own base.
 *
 *   'egress'          — zero is the egress file start; matches assembled rows
 *   'first_utterance' — zero is the earliest utterance; used when no egress
 *                       epoch was recorded (missing or failed webhook)
 *   'none'            — nothing to anchor against; offsets stay null
 *
 * ponytail: the two bases mean different things, so a transcript re-read after
 * the summary job lands can shift if speech started after egress. `timebase`
 * travels in the response so a caller can tell which zero it is looking at.
 */
export function resolveUtteranceTimebase(utterances, recording) {
  if (!utterances?.length) return { baseMs: null, timebase: 'none' };
  const egressBase = recording?.egressFileStartedAtEpochMs ?? recording?.egressStartedAtEpochMs ?? null;
  if (egressBase != null) return { baseMs: egressBase, timebase: 'egress' };
  let min = null;
  for (const u of utterances) {
    const t = u?.startedAtEpochMs;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (min === null || t < min) min = t;
  }
  if (min === null) return { baseMs: null, timebase: 'none' };
  return { baseMs: min, timebase: 'first_utterance' };
}

/** Absolute epoch ms -> ms from `baseMs`. Null when unanchored or before zero. */
export function offsetFromBase(epochMs, baseMs) {
  if (baseMs == null) return null;
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null;
  const offset = epochMs - baseMs;
  return offset < 0 ? null : offset;
}

/** TranscriptBatch/assembled utterance -> the shape the transcript read APIs return. */
export function mapV2Utterances(rawUtterances, recording) {
  const rows = rawUtterances || [];
  const { baseMs, timebase } = resolveUtteranceTimebase(rows, recording);
  const utterances = rows.map((u) => {
    const startMs = u.recordingOffsetMs ?? offsetFromBase(u.startedAtEpochMs, baseMs);
    const endMs = offsetFromBase(u.endedAtEpochMs, baseMs);
    return {
      utteranceId: u.utteranceId,
      speaker: u.participantIdentity ?? null,
      speakerName: u.displayName ?? null,
      speakerRole: u.speakerRole ?? null,
      roleAssurance: u.roleAssurance ?? null,
      text: u.text,
      startMs,
      endMs,
      recordingOffsetMs: u.recordingOffsetMs ?? startMs,
      startedAtEpochMs: u.startedAtEpochMs ?? null,
      endedAtEpochMs: u.endedAtEpochMs ?? null,
      confidence: u.confidence ?? null,
    };
  });
  return { utterances, timebase };
}

/**
 * One synthetic segment for v1 clients (Communication -> Recordings TranscriptModal)
 * that only read `segments`. The window ends at the latest utterance END: rows are
 * sorted by start, so a long utterance can outlast a later one.
 */
export function buildV2Segment(utterances) {
  if (!utterances?.length) return null;
  let windowEndMs = 0;
  for (const u of utterances) {
    const end = u.endMs ?? u.startMs ?? 0;
    if (end > windowEndMs) windowEndMs = end;
  }
  return {
    id: 'v2',
    sequenceNumber: 1,
    windowStartMs: utterances[0].startMs ?? 0,
    windowEndMs,
    combinedText: utterances.map((u) => u.text).join(' '),
    utteranceCount: utterances.length,
    utterances,
  };
}
