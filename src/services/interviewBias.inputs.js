import mongoose from 'mongoose';

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/**
 * Recruiter feedback for bias v1 is scorecard ratings/comment only — ignore Meeting.notes.
 * @param {object|null|undefined} scorecard
 * @returns {boolean}
 */
export function hasUsableScorecard(scorecard) {
  if (!scorecard || typeof scorecard !== 'object') return false;
  const ratings = Array.isArray(scorecard.ratings) ? scorecard.ratings : [];
  const comment = typeof scorecard.comment === 'string' ? scorecard.comment.trim() : '';
  const hasRating = ratings.some((r) => r && r.rating != null && r.rating !== '');
  return hasRating || comment.length > 0;
}

/**
 * Resolve Job _id from linkage fields. Title-only jobPosition is not a JD source.
 * @param {{ jobId?: unknown, jobPosition?: unknown }} meeting
 * @returns {string|null}
 */
export function resolveJobIdFromMeeting(meeting) {
  const jobId = meeting?.jobId ? String(meeting.jobId).trim() : '';
  if (OBJECT_ID_HEX.test(jobId) && mongoose.Types.ObjectId.isValid(jobId)) return jobId;
  const jobPos = typeof meeting?.jobPosition === 'string' ? meeting.jobPosition.trim() : '';
  if (OBJECT_ID_HEX.test(jobPos) && mongoose.Types.ObjectId.isValid(jobPos)) return jobPos;
  return null;
}

/**
 * Pick a skip reason before calling the LLM. Empty speech counts as no transcript.
 * @param {{ hasScorecard: boolean, jobDescription: string, utterances: Array<{ text?: string }> }} input
 * @returns {string|null}
 */
export function decideBiasSkip({ hasScorecard, jobDescription, utterances }) {
  if (!hasScorecard) return 'no_scorecard';
  const jd = typeof jobDescription === 'string' ? jobDescription.trim() : '';
  if (!jd) return 'no_job_description';
  const rows = Array.isArray(utterances) ? utterances : [];
  const hasSpeech = rows.some((u) => String(u?.text || '').trim());
  if (!hasSpeech) return 'no_transcript';
  return null;
}

/**
 * Whether a background trigger should enqueue (staff Re-run bypasses this).
 * @param {{ hasScorecard: boolean, hasTranscript: boolean }} input
 * @returns {boolean}
 */
export function shouldEnqueueBiasCheck({ hasScorecard, hasTranscript }) {
  return Boolean(hasScorecard && hasTranscript);
}

/**
 * BullMQ rejects `:`. Keep job ids hyphen-safe.
 * @param {string} meetingId
 * @returns {string}
 */
export function sanitizeBiasJobMeetingKey(meetingId) {
  return String(meetingId || 'unknown').replace(/:/g, '_');
}

/**
 * List/detail chip only — never quotes, flags, or skip copy.
 * @param {object|null|undefined} biasCheck
 * @returns {{ status: string|null, riskLevel: string|null }}
 */
export function serializeBiasSummary(biasCheck) {
  if (!biasCheck || typeof biasCheck !== 'object') {
    return { status: null, riskLevel: null };
  }
  return {
    status: biasCheck.status || null,
    riskLevel: biasCheck.riskLevel || null,
  };
}

/**
 * Compact scorecard for the LLM — no scorer identity.
 * @param {object|null|undefined} scorecard
 * @returns {{ ratings: Array<{ criterion: string, rating: number }>, comment: string }}
 */
export function scorecardForPrompt(scorecard) {
  const ratings = (scorecard?.ratings || [])
    .filter((r) => r && (r.criterion != null || r.key != null) && r.rating != null)
    .map((r) => ({ criterion: String(r.criterion || r.key), rating: Number(r.rating) }));
  return {
    ratings,
    comment: typeof scorecard?.comment === 'string' ? scorecard.comment.trim() : '',
  };
}

/**
 * Flatten legacy TranscriptSegment utterances into the bias prompt shape.
 * @param {Array<{ sequenceNumber?: number, utterances?: Array<object> }>} segments
 * @param {number} [maxRows]
 * @returns {Array<{ utteranceId: string, speakerRole: string, text: string }>}
 */
export function utterancesFromLegacySegments(segments, maxRows = 80) {
  const rows = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    for (const u of seg.utterances || []) {
      const text = String(u?.text || '').trim();
      if (!text) continue;
      rows.push({
        utteranceId: `${seg.sequenceNumber ?? 0}-${u.startMs ?? rows.length}`,
        speakerRole: String(u.speakerLabel || u.speaker || 'unknown'),
        text,
      });
      if (rows.length >= maxRows) return rows;
    }
  }
  return rows;
}
