import config from '../config/config.js';

const CHARS_PER_TOKEN = 4;

export function estimateTranscriptTokens(segments = []) {
  let chars = 0;
  for (const s of segments) chars += (s.combinedText || '').length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function applyCostGate({ estTokens, durationMinutes }) {
  if (estTokens > config.ai.maxTranscriptTokens) {
    return {
      ok: false,
      reason: `transcript tokens (${estTokens}) exceed MAX_TRANSCRIPT_TOKENS (${config.ai.maxTranscriptTokens})`,
    };
  }
  if (durationMinutes > config.ai.maxMeetingDurationMinutes) {
    return {
      ok: false,
      reason: `meeting duration (${durationMinutes} min) exceeds MAX_MEETING_DURATION_MINUTES (${config.ai.maxMeetingDurationMinutes})`,
    };
  }
  return { ok: true };
}

export function splitUtterancesIntoWindows(utterances = [], maxTokens = config.ai.mapWindowTokens) {
  if (!utterances.length) return [];
  const windows = [];
  let current = [];
  let tokens = 0;
  let prevSpeaker = null;

  for (const u of utterances) {
    const t = Math.ceil((u.text || '').length / CHARS_PER_TOKEN);
    const speakerChanged = prevSpeaker !== null && u.speaker !== prevSpeaker;
    if (tokens + t > maxTokens && speakerChanged && current.length > 0) {
      windows.push(current);
      current = [];
      tokens = 0;
    }
    current.push(u);
    tokens += t;
    prevSpeaker = u.speaker;
  }
  if (current.length) windows.push(current);
  return windows;
}

// finalizeSummary + mapReduceSummarize + helpers filled in subsequent tasks.
export async function finalizeSummary(_payload) {
  throw new Error('not yet implemented');
}
