/**
 * Staff-only advisory interview bias check (v1).
 * Never gates or writes Meeting.interviewResult.
 */

export const BIAS_PROMPT_VERSION = 'bias-v1';
export const BIAS_MODEL = 'gpt-4o-mini';

export const BIAS_CHECK_STATUSES = Object.freeze(['pending', 'ready', 'skipped', 'failed']);
export const BIAS_RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const BIAS_FLAG_CATEGORIES = Object.freeze([
  'protected_class',
  'score_mismatch',
  'vague_culture_fit',
]);
export const BIAS_EVIDENCE_SOURCES = Object.freeze(['transcript', 'scorecard_comment']);

export const BIAS_SKIP_REASONS = Object.freeze({
  no_transcript: 'no_transcript',
  no_scorecard: 'no_scorecard',
  no_job_description: 'no_job_description',
  cost_gate: 'cost_gate',
  queue_unavailable: 'queue_unavailable',
  llm_unavailable: 'llm_unavailable',
});

/** User-facing skip copy — keep in sync with InterviewBiasPanel. */
export const BIAS_SKIP_COPY = Object.freeze({
  no_transcript: "Can't analyze — no interview recording transcript.",
  no_scorecard: "Can't analyze — save a scorecard with ratings or comments first.",
  no_job_description: "Can't analyze — this interview isn't linked to a job description.",
  cost_gate: "Can't analyze — transcript is too long for automatic review.",
  queue_unavailable: "Can't analyze — review queue is unavailable. Try Re-run.",
  llm_unavailable: "Can't analyze — AI review is not configured.",
});

export const BIAS_ADVISORY_NOTICE =
  'If you opt in, an AI system may analyse the transcript against job criteria to produce advisory scores. A human makes the final decision; you may request deletion of AI outputs.';
