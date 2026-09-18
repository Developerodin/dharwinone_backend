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
  return ratings.length > 0 || comment.length > 0;
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
 * Compact scorecard for the LLM — no scorer identity.
 * @param {object|null|undefined} scorecard
 * @returns {{ ratings: Array<{ criterion: string, rating: number }>, comment: string }}
 */
export function scorecardForPrompt(scorecard) {
  const ratings = (scorecard?.ratings || [])
    .filter((r) => r && r.criterion != null && r.rating != null)
    .map((r) => ({ criterion: String(r.criterion), rating: Number(r.rating) }));
  return {
    ratings,
    comment: typeof scorecard?.comment === 'string' ? scorecard.comment.trim() : '',
  };
}
