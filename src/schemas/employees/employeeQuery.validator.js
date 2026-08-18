import {
  DEFAULT_PAGINATION,
  ERROR_CODES,
  MAX_PAGINATION_LIMIT,
} from '../entityQuery.contract.js';
import { employeeStructuredQuerySchema } from './employeeFilter.joi.generated.js';

const UNSUPPORTED_RELATION_MESSAGE = 'This employee relationship query is not supported yet.';

/**
 * Validate and normalize a raw employee StructuredQuery.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, query: object } | { ok: false, error: string, code: string }}
 */
export function validateEmployeeQuery(raw) {
  if (raw != null && typeof raw === 'object' && Array.isArray(raw.relations) && raw.relations.length > 0) {
    return {
      ok: false,
      code: ERROR_CODES.UNSUPPORTED_RELATION,
      error: UNSUPPORTED_RELATION_MESSAGE,
    };
  }

  const preprocessed = preprocessPaginationLimit(raw);

  // Unknown keys must ERROR, never be deleted: a silently-dropped filter widens
  // the query and the deterministic renderer then states the wrong number with
  // full confidence. See docs/superpowers/plans/2026-08-10-entityquery-remediation.md T4.
  const { value, error } = employeeStructuredQuerySchema.validate(preprocessed, {
    abortEarly: false,
  });

  if (error) {
    return {
      ok: false,
      code: ERROR_CODES.VALIDATION,
      error: error.details.map((detail) => detail.message).join(', '),
    };
  }

  return { ok: true, query: normalizeQuery(value) };
}

function preprocessPaginationLimit(raw) {
  if (raw == null || typeof raw !== 'object' || !raw.pagination || typeof raw.pagination !== 'object') {
    return raw;
  }

  const limit = raw.pagination.limit;
  if (typeof limit !== 'number' || limit <= MAX_PAGINATION_LIMIT) {
    return raw;
  }

  return {
    ...raw,
    pagination: {
      ...raw.pagination,
      limit: MAX_PAGINATION_LIMIT,
    },
  };
}

function normalizeQuery(value) {
  const query = { ...value };

  if (query.filters && typeof query.filters === 'object') {
    query.filters = stripEmptyFilterKeys(query.filters);
    if (Object.keys(query.filters).length === 0) {
      delete query.filters;
    }
  }

  if (!query.pagination) {
    query.pagination = { ...DEFAULT_PAGINATION };
  }

  if (!Array.isArray(query.relations)) {
    query.relations = [];
  }

  return query;
}

function stripEmptyFilterKeys(filters) {
  // Empty strings go too, not just null/undefined. `filters.id: ''` used to survive
  // here, and toApiFilter's `if (apiFilter.id)` then left it unmapped — so a query
  // narrowed to one employee silently returned the whole scoped roster. Same
  // fail-open shape T10 closed, one layer up.
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, filterValue]) => filterValue !== undefined && filterValue !== null && filterValue !== ''
    )
  );
}
