/** Shared StructuredQuery contract constants (entity-agnostic shell, employees Phase 1). */

export const ENTITY_EMPLOYEES = 'employees';

/**
 * Only operations an executor actually implements.
 *
 * Documentation, NOT enforcement — nothing imports this. The enum that actually
 * rejects a query lives in employees/employeeFilter.schema.json and is compiled
 * into employeeFilter.joi.generated.js. Widening this constant alone enables
 * nothing; widening the JSON schema without adding an executor branch produces a
 * validated query that dies on employeeQuery.executor.js's trailing
 * "No supported operations requested." Change both, or neither.
 */
export const OPERATIONS = Object.freeze(['count', 'list', 'get']);

export const ERROR_CODES = Object.freeze({
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION: 'VALIDATION',
  EXECUTION: 'EXECUTION',
  UNSUPPORTED_RELATION: 'UNSUPPORTED_RELATION',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
});

/** Default pagination for employee list/count queries. */
export const DEFAULT_PAGINATION = Object.freeze({ page: 1, limit: 50 });

export const MAX_PAGINATION_LIMIT = 100;

/** getAll hard cap — partial responses must set truncated + returned. */
export const GET_ALL_MAX_RECORDS = 500;

export const GET_ALL_TIMEOUT_MS = 30000;
