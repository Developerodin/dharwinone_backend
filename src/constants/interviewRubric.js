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
