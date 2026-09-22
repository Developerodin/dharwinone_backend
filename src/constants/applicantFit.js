export const LLM_TIMEOUT_MS = 4000;
export const LLM_BACKGROUND_TIMEOUT_MS = 30000;
export const LLM_BATCH_MAX = 10;
export const LLM_RATIONALE_MAX = 140;
export const LLM_CLAMP_PCT = 0.4;
export const LLM_CLAMP_MIN_WINDOW = 15;

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const JD_MAX_CHARS = 2000;
export const BIO_MAX_CHARS = 400;
export const COVER_LETTER_MAX_CHARS = 400;
export const EXPERIENCE_CAP = 6;
export const QUALIFICATION_CAP = 4;

export const CULTURAL_FIT_VALUES = Object.freeze(['fit', 'not_fit', 'unclear']);

export const CULTURAL_FIT_LABELS = Object.freeze({
  fit: 'Fit',
  not_fit: 'Not a fit',
  unclear: 'Unclear',
});
