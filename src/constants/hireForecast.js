export const LIVE_APPLICATION_STATUSES = Object.freeze([
  'Applied',
  'Screening',
  'Interview',
  'Shortlisted',
  'Offered',
]);

export const ADVANCED_APPLICATION_STATUSES = Object.freeze(['Interview', 'Shortlisted', 'Offered']);

export const MIN_FORECAST_DAYS = 3;
export const MAX_FORECAST_DAYS = 180;

export const BASE_DAYS_BY_SENIORITY = Object.freeze({
  'Entry Level': 21,
  'Mid Level': 35,
  'Senior Level': 49,
  Executive: 70,
});

export const DEFAULT_BASE_DAYS = 35;

export const FIT_SCORE_CAP_PER_JOB = 80;
export const FIT_SAMPLE_CAP_PER_JOB = 200;

export const LLM_TIMEOUT_MS = 4000;
export const LLM_BATCH_MAX = 20;
export const LLM_RATIONALE_MAX = 140;
export const LLM_CLAMP_PCT = 0.4;

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const STRONG_FIT_SCORE = 80;
