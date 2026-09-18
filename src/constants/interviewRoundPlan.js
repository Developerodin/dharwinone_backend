import { INTERVIEW_ROUND_TYPES } from './interviewLinkage.js';
import { criteriaWeightError } from './interviewRubric.js';

/**
 * A job may plan at most this many rounds. Nine round types exist and a real hiring
 * process runs to single digits, so twelve leaves headroom without letting the job form
 * become a spreadsheet. Mirrors MAX_PLANNED_ROUNDS in shared/lib/api/jobs.ts.
 */
export const MAX_PLANNED_ROUNDS = 12;

/**
 * A plan row's key. Generated once when the row is added and then FROZEN — it is what
 * Meeting.round.planKey stores and what JobApplication.roundPlanSnapshot repeats, so
 * changing it orphans every round already held against that row.
 *
 * Deliberately not derived from the label: a key that followed the label would change as
 * the user types, and every meeting pointing at the old value would fall off the plan.
 */
export const ROUND_PLAN_KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

/** A collision-free plan key. `taken` is the keys already used by sibling rows. */
export const nextPlanKey = (taken = new Set()) => {
  for (let n = 1; n <= MAX_PLANNED_ROUNDS * 4; n += 1) {
    const candidate = `round_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `round_${Date.now()}`.slice(0, 40);
};

/** A round's name for an error message. Falls back to its position, which always exists. */
export const planRowLabel = (row, index) => {
  const label = String(row?.label || '').trim();
  return label || `Round ${index + 1}`;
};

/**
 * Validate `Job.interviewRounds`.
 *
 * Shared by the Joi schema and the service so a plan can never reach the database in a
 * shape the resolver or the progress derivation cannot handle. Returns a sentence meant
 * for the person editing the job, or null.
 *
 * Deliberately DIFFERENT from rubricAssignmentsError in exactly one respect: a round type
 * may repeat. "Technical 1" and "Technical 2" at different bars is the reason this field
 * exists, and the old one-row-per-type rule is what made that impossible.
 *
 * Failure modes handled: null and empty (a job with no opinion — the default, and the
 * state of every job that predates this field), a non-array, over-length, a missing or
 * malformed key, a duplicate key, a blank label, an unknown round type, a row naming both
 * or neither of template and criteria, and criteria whose weights do not sum to 100.
 *
 * Not handled, deliberately: whether the named template still exists. A dangling
 * reference must never block saving a job — resolution falls through instead (see
 * resolveRubricForRound).
 *
 * @param {Array<object>|null|undefined} rounds
 * @returns {string|null}
 */
export const roundPlanError = (rounds) => {
  if (rounds == null) return null;
  if (!Array.isArray(rounds)) return 'Interview rounds must be a list.';
  if (rounds.length === 0) return null;
  if (rounds.length > MAX_PLANNED_ROUNDS) {
    return `A job can plan at most ${MAX_PLANNED_ROUNDS} interview rounds.`;
  }

  const seenKeys = new Set();

  for (let i = 0; i < rounds.length; i += 1) {
    const row = rounds[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return `Round ${i + 1} must be an object.`;
    }

    const name = planRowLabel(row, i);

    const key = String(row.key || '').trim();
    if (!key) return `${name} needs an internal key.`;
    if (!ROUND_PLAN_KEY_PATTERN.test(key)) {
      return `${name} has an invalid internal key. Use lower-case letters, numbers, hyphens or underscores.`;
    }
    if (seenKeys.has(key)) return `Two rounds share the internal key "${key}".`;
    seenKeys.add(key);

    const label = String(row.label || '').trim();
    if (!label) return `Round ${i + 1} needs a name.`;
    if (label.length > 80) return `${name}: the name is too long (80 characters maximum).`;

    const roundType = row.roundType ?? null;
    if (roundType !== null && roundType !== '' && !INTERVIEW_ROUND_TYPES.includes(roundType)) {
      return `"${roundType}" is not an interview round type.`;
    }

    const hasTemplate = Boolean(row.templateId);
    const hasCriteria = Array.isArray(row.criteria) && row.criteria.length > 0;
    if (hasTemplate === hasCriteria) {
      return `${name} needs either a saved rubric or its own criteria — not both, and not neither.`;
    }

    if (hasCriteria) {
      const reason = criteriaWeightError(row.criteria);
      if (reason) return `${name}: ${reason}`;
    }
  }

  return null;
};
