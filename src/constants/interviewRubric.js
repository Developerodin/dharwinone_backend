import { INTERVIEW_ROUND_TYPES } from './interviewLinkage.js';

/**
 * Interview scoring rubric (PRD 5.4).
 *
 * Fixed criteria, equal weight, informational only — the rubric never gates or derives
 * Meeting.interviewResult. One score set per interview; a later scorer overwrites it.
 *
 * ponytail: no weights and no per-job templates. If rubrics ever need to differ by job,
 * that is a RubricTemplate model + admin CRUD + job link, not a bigger constant here.
 */

export const RUBRIC_CRITERIA = Object.freeze([
  Object.freeze({ id: 'technical', label: 'Technical Skills' }),
  Object.freeze({ id: 'communication', label: 'Communication' }),
  Object.freeze({ id: 'problemSolving', label: 'Problem Solving' }),
  Object.freeze({ id: 'cultureFit', label: 'Culture Fit' }),
  Object.freeze({ id: 'experience', label: 'Relevant Experience' }),
]);

export const RUBRIC_CRITERION_IDS = Object.freeze(RUBRIC_CRITERIA.map((c) => c.id));

export const RUBRIC_RATING_MIN = 1;
export const RUBRIC_RATING_MAX = 5;

/**
 * ---------------------------------------------------------------------------
 * Weighted rubric (configurable). Everything above this line is the LEGACY
 * fixed rubric: it still backs Meeting.interviewScorecard, which is read but
 * no longer written. Do not add criteria to RUBRIC_CRITERIA.
 * ---------------------------------------------------------------------------
 */

/** Weights are percentages and a template's must sum to exactly this. */
export const RUBRIC_WEIGHT_TOTAL = 100;

/**
 * The rubric used when no template matches a round. These are the categories and
 * weights the module scope gives as its worked example, so an install that never
 * configures a template still gets a real weighted score instead of a blank form.
 *
 * `key` is a stable slug: it is what a stored rating references. Renaming a key
 * orphans every rating that used it, so change `label` instead.
 */
export const DEFAULT_RUBRIC_CRITERIA = Object.freeze([
  Object.freeze({ key: 'technical', label: 'Technical Skills', weight: 40, scaleMin: 1, scaleMax: 5 }),
  Object.freeze({ key: 'communication', label: 'Communication Skills', weight: 25, scaleMin: 1, scaleMax: 5 }),
  Object.freeze({ key: 'problemSolving', label: 'Problem Solving', weight: 20, scaleMin: 1, scaleMax: 5 }),
  Object.freeze({ key: 'cultureFit', label: 'Cultural Fit', weight: 15, scaleMin: 1, scaleMax: 5 }),
]);

/**
 * Validate a criteria list's shape and weights.
 *
 * Shared by the Joi schema and the service so a template can never be stored with
 * weights that do not add up — a weighted score against a 90% or 110% rubric is not
 * wrong by a little, it is meaningless.
 *
 * @param {Array<{key: string, label: string, weight: number, scaleMin?: number, scaleMax?: number}>} criteria
 * @returns {string|null} a user-facing reason, or null when the list is valid
 */
export const criteriaWeightError = (criteria) => {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return 'A rubric needs at least one criterion.';
  }
  const keys = new Set();
  let total = 0;
  for (const criterion of criteria) {
    const key = String(criterion?.key || '').trim();
    if (!key) return 'Every criterion needs a key.';
    if (keys.has(key)) return `Duplicate criterion key: ${key}`;
    keys.add(key);

    const weight = Number(criterion?.weight);
    if (!Number.isInteger(weight) || weight < 0 || weight > RUBRIC_WEIGHT_TOTAL) {
      return `Weight for "${key}" must be a whole number between 0 and ${RUBRIC_WEIGHT_TOTAL}.`;
    }
    total += weight;

    const scaleMin = Number(criterion?.scaleMin ?? 1);
    const scaleMax = Number(criterion?.scaleMax ?? 5);
    if (!Number.isInteger(scaleMin) || !Number.isInteger(scaleMax) || scaleMax <= scaleMin) {
      return `Scale for "${key}" must be two whole numbers with the maximum above the minimum.`;
    }
  }
  if (total !== RUBRIC_WEIGHT_TOTAL) {
    return `Weights must add up to ${RUBRIC_WEIGHT_TOTAL}%. This rubric adds up to ${total}%.`;
  }
  return null;
};

/**
 * A job may declare at most this many rubric assignments. There are nine round types plus
 * one job default, so twelve leaves headroom without letting a job form become a spreadsheet.
 */
export const MAX_RUBRIC_ASSIGNMENTS = 12;

/**
 * Validate `Job.rubricAssignments`.
 *
 * The invariant that matters: each row names EITHER a saved template or its own criteria,
 * never both and never neither. Both would force resolution to pick a winner at read time
 * in two separate services; neither leaves the row unresolvable (audit J5).
 *
 * `roundType: null` is the job's own default — the row used by any round the job has not
 * named specifically, including rounds scheduled with no type at all. It may appear once.
 *
 * An empty or absent list is VALID and means "this job has no opinion"; resolution then
 * falls through to the template rungs. That is the state of every job that exists today.
 *
 * A criteria error names its round type on purpose: a bare "weights must add up to 100"
 * inside a 900-line job form gives the user nothing to act on (audit J10).
 *
 * @param {Array<{roundType: string|null, templateId?: string|null, criteria?: Array<object>|null}>} assignments
 * @returns {string|null} a user-facing reason, or null when valid
 */
export const rubricAssignmentsError = (assignments) => {
  if (assignments == null) return null;
  if (!Array.isArray(assignments)) return 'Interview scoring must be a list of assignments.';
  if (assignments.length === 0) return null;
  if (assignments.length > MAX_RUBRIC_ASSIGNMENTS) {
    return `A job can have at most ${MAX_RUBRIC_ASSIGNMENTS} rubric assignments.`;
  }

  const seen = new Set();

  for (const row of assignments) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return 'Each rubric assignment must be an object.';
    }

    const roundType = row.roundType ?? null;
    if (roundType !== null && roundType !== '' && !INTERVIEW_ROUND_TYPES.includes(roundType)) {
      return `"${roundType}" is not an interview round type.`;
    }
    const normalizedType = roundType === '' ? null : roundType;

    const key = normalizedType === null ? '__default__' : normalizedType;
    if (seen.has(key)) {
      return normalizedType
        ? `The ${normalizedType} round is set more than once.`
        : 'The job default is set more than once.';
    }
    seen.add(key);

    const label = normalizedType ? `the ${normalizedType} round` : 'rounds with no specific rubric';
    const hasTemplate = Boolean(row.templateId);
    const hasCriteria = Array.isArray(row.criteria) && row.criteria.length > 0;
    if (hasTemplate === hasCriteria) {
      return `${label} needs either a saved rubric or its own criteria — not both, and not neither.`;
    }

    if (hasCriteria) {
      const reason = criteriaWeightError(row.criteria);
      if (reason) return `${label}: ${reason}`;
    }
  }

  return null;
};
