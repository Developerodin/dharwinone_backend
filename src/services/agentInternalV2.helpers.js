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
