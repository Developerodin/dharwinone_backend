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
