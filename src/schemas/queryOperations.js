/** Generic structured query operations — entity-agnostic shell. */

export const ENTITY_JOB = 'job';
export const ENTITY_EMPLOYEES = 'employees';

/** Extensible operation enum for ranking / aggregation queries. */
export const OPERATIONS = Object.freeze([
  'LIST',
  'COUNT',
  'GET',
  'MAX',
  'MIN',
  'TOP_N',
  'RANK',
]);

export const JOB_SALARY_METRIC = 'salary';
export const JOB_SALARY_SORT_FIELD = 'salaryRange.max';

export const DEFAULT_JOB_RANK_LIMIT = 10;
export const MAX_JOB_RANK_LIMIT = 50;
