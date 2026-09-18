/**
 * Weighted interview score. ONE implementation, used by the evaluation write path, the
 * round-history read path and the frontend form — a second copy would drift.
 *
 * Normalisation is (rating - scaleMin) / (scaleMax - scaleMin), so the bottom of the
 * scale contributes nothing. Dividing by scaleMax instead would score the worst
 * possible candidate at 20% on a 1-5 scale.
 *
 * The denominator is the weight of the criteria actually rated, NOT 100. A half-filled
 * card therefore reports an honest score for what was judged, and `isComplete` /
 * `coveragePct` are what stop it being read as a full result (audit R2). Both must be
 * surfaced wherever the score is.
 *
 * Ceiling: weights are plain numbers with no interviewer calibration. If scores ever
 * need comparing across interviewers, that is a calibration layer on top of this, not
 * a change to this function.
 */

const toFiniteNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const round1 = (value) => Number(value.toFixed(1));

/**
 * @param {Array<{key: string, label?: string, weight: number, scaleMin: number, scaleMax: number}>} criteria
 *   The rubric snapshot on the round — never the live template.
 * @param {Array<{key: string, rating: number|null, notApplicable?: boolean}>} ratings
 * @returns {{weightedScore: number|null, coveragePct: number, scoredCount: number, totalCount: number, isComplete: boolean}}
 */
export const computeWeightedScore = (criteria, ratings) => {
  const criteriaList = Array.isArray(criteria) ? criteria : [];
  const ratingsList = Array.isArray(ratings) ? ratings : [];

  const byKey = new Map();
  for (const entry of ratingsList) {
    if (entry && typeof entry.key === 'string' && entry.key) byKey.set(entry.key, entry);
  }

  let weightedSum = 0;
  let ratedWeight = 0;
  let applicableWeight = 0;
  let scoredCount = 0;
  let totalCount = 0;

  for (const criterion of criteriaList) {
    if (!criterion || typeof criterion.key !== 'string' || !criterion.key) continue;
    const entry = byKey.get(criterion.key);
    if (entry?.notApplicable) continue;

    const weight = toFiniteNumber(criterion.weight) ?? 0;
    const scaleMin = toFiniteNumber(criterion.scaleMin) ?? 1;
    const scaleMax = toFiniteNumber(criterion.scaleMax) ?? 5;
    const span = scaleMax - scaleMin;

    // A zero weight or a collapsed scale cannot contribute; counting it in the
    // denominator would divide by zero or silently drag the result.
    if (weight <= 0 || span <= 0) continue;

    totalCount += 1;
    applicableWeight += weight;

    const rating = toFiniteNumber(entry?.rating);
    if (rating == null) continue;

    const clamped = Math.min(Math.max(rating, scaleMin), scaleMax);
    weightedSum += ((clamped - scaleMin) / span) * weight;
    ratedWeight += weight;
    scoredCount += 1;
  }

  const weightedScore = ratedWeight > 0 ? round1((weightedSum / ratedWeight) * 100) : null;
  const coveragePct = applicableWeight > 0 ? round1((ratedWeight / applicableWeight) * 100) : 0;

  return {
    weightedScore,
    coveragePct,
    scoredCount,
    totalCount,
    isComplete: totalCount > 0 && scoredCount === totalCount,
  };
};

export default computeWeightedScore;
