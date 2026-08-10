import {
  buildEmployeeListMongoFilter,
  countEmployeeCandidates,
  getCandidateById,
  queryCandidates,
} from '../../services/employee.service.js';
import {
  DEFAULT_PAGINATION,
  ERROR_CODES,
  GET_ALL_MAX_RECORDS,
  GET_ALL_TIMEOUT_MS,
  MAX_PAGINATION_LIMIT,
} from '../entityQuery.contract.js';
import {
  authorizeEmployeeQuery,
  maskEmployeeRecord,
  maskEmployeeRecords,
} from './employeeQuery.rbac.js';
import { projectEmployeeRecord, projectEmployeeRecords } from './employeeQuery.projection.js';
import { applyEmployeeListScope, toApiFilter } from './employeeQuery.scope.js';

const CHAT_LIST_OPTIONS = Object.freeze({
  includeOpenSopCount: false,
  skipProfilePicturePresign: true,
  includeCompensationCounts: false,
});

/**
 * @param {object} filters
 * @returns {object}
 */
function normalizeExecutorFilters(filters = {}) {
  const next = { ...filters };
  if (next.employmentStatus === 'active') {
    next.employmentStatus = 'current';
  }
  return next;
}

function toPlainRecord(record) {
  if (!record) return null;
  return record.toObject ? record.toObject() : { ...record };
}

function buildSuccessResult(validatedQuery, partial) {
  return {
    success: true,
    source: 'employees',
    query: validatedQuery,
    ...partial,
  };
}

function buildFailureResult(code, message) {
  return {
    success: false,
    error: code,
    message,
  };
}

async function resolveScopedApiFilter(validatedQuery, user, deps) {
  const applyScope = deps.applyEmployeeListScope ?? applyEmployeeListScope;
  const normalizedFilters = normalizeExecutorFilters(validatedQuery.filters);
  const apiFilter = toApiFilter(normalizedFilters);
  return applyScope(apiFilter, user, user.authContext, deps.scopeDeps);
}

async function executeGetOperation(validatedQuery, user, auth, deps) {
  const employeeId = validatedQuery.filters?.id;
  if (!employeeId) {
    return buildFailureResult(ERROR_CODES.VALIDATION, 'Employee id is required for get operation.');
  }

  const getById = deps.getCandidateById ?? getCandidateById;
  const buildFilter = deps.buildEmployeeListMongoFilter ?? buildEmployeeListMongoFilter;
  const countFn = deps.countEmployeeCandidates ?? countEmployeeCandidates;
  const applyScope = deps.applyEmployeeListScope ?? applyEmployeeListScope;

  const record = await getById(employeeId);
  if (!record) {
    return buildFailureResult(ERROR_CODES.EXECUTION, 'Employee not found.');
  }

  // buildEmployeeListMongoFilter defaults an absent employmentStatus to 'current',
  // which makes every resigned employee fail the in-scope probe. The probe asks
  // "may this viewer see this row at all", which is status-independent.
  const scopedFilter = await applyScope(
    { employmentStatus: 'all' },
    user,
    user.authContext,
    deps.scopeDeps
  );
  const { mongoFilter } = await buildFilter(scopedFilter);
  const inScope = await countFn({ ...mongoFilter, _id: employeeId });

  if (inScope !== 1) {
    return buildFailureResult(ERROR_CODES.FORBIDDEN, 'You do not have permission to view this employee.');
  }

  const plain = maskEmployeeRecord(projectEmployeeRecord(toPlainRecord(record)), auth.maskSalaryFields);
  return buildSuccessResult(validatedQuery, {
    provenance: 'employee.service.getCandidateById',
    total: 1,
    records: [plain],
  });
}

async function fetchAllRecords(apiFilter, total, deps, deadlineMs) {
  const listFn = deps.queryCandidates ?? queryCandidates;
  const records = [];
  let page = 1;
  const pageLimit = MAX_PAGINATION_LIMIT;

  while (records.length < GET_ALL_MAX_RECORDS && Date.now() < deadlineMs) {
    const remaining = GET_ALL_MAX_RECORDS - records.length;
    const limit = Math.min(pageLimit, remaining);
    const listResult = await listFn(
      { ...apiFilter, includeOpenSopCount: false },
      {
        page,
        limit,
        ...CHAT_LIST_OPTIONS,
      }
    );
    const batch = listResult.results || [];
    if (batch.length === 0) break;
    records.push(...batch);
    if (batch.length < limit) break;
    page += 1;
  }

  const truncated = total > records.length;
  const returned = records.length;

  return {
    records,
    truncated,
    returned,
  };
}

async function computeEmploymentBreakdown(apiFilter, deps) {
  const buildFilter = deps.buildEmployeeListMongoFilter ?? buildEmployeeListMongoFilter;
  const countFn = deps.countEmployeeCandidates ?? countEmployeeCandidates;

  const [{ mongoFilter: currentMongo }, { mongoFilter: resignedMongo }] = await Promise.all([
    buildFilter({ ...apiFilter, employmentStatus: 'current' }),
    buildFilter({ ...apiFilter, employmentStatus: 'resigned' }),
  ]);

  const [active, resigned] = await Promise.all([
    countFn(currentMongo),
    countFn(resignedMongo),
  ]);

  return { active, resigned, total: active + resigned };
}

async function executeListOperation(validatedQuery, user, auth, apiFilter, total, deps) {
  const listFn = deps.queryCandidates ?? queryCandidates;
  const pagination = validatedQuery.pagination ?? DEFAULT_PAGINATION;
  const page = pagination.page ?? DEFAULT_PAGINATION.page;
  const limit = pagination.limit ?? DEFAULT_PAGINATION.limit;

  if (validatedQuery.getAll) {
    const deadlineMs = (deps.now?.() ?? Date.now()) + GET_ALL_TIMEOUT_MS;
    const { records, truncated, returned } = await fetchAllRecords(apiFilter, total, deps, deadlineMs);
    const masked = maskEmployeeRecords(projectEmployeeRecords(records), auth.maskSalaryFields);

    return buildSuccessResult(validatedQuery, {
      provenance: 'employee.service.queryCandidates',
      total,
      records: masked,
      ...(truncated ? { truncated: true, returned } : {}),
    });
  }

  const listResult = await listFn(
    { ...apiFilter, includeOpenSopCount: false },
    {
      page,
      limit,
      ...CHAT_LIST_OPTIONS,
    }
  );

  const records = maskEmployeeRecords(projectEmployeeRecords(listResult.results || []), auth.maskSalaryFields);
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

  return buildSuccessResult(validatedQuery, {
    provenance: 'employee.service.queryCandidates',
    total,
    page,
    limit,
    hasNextPage: page < totalPages,
    records,
  });
}

/**
 * Execute a validated employee StructuredQuery against employee.service.
 *
 * @param {object} validatedQuery
 * @param {object} user
 * @param {object} [deps] - Injectable service fns for tests
 * @returns {Promise<object>} ToolResultContract
 */
export async function executeEmployeeQuery(validatedQuery, user, deps = {}) {
  const auth = authorizeEmployeeQuery(validatedQuery, user);
  if (!auth.allowed) {
    return buildFailureResult(auth.code, auth.error);
  }

  const operations = validatedQuery.operations || [];
  const wantsGet = operations.includes('get');
  const wantsCount = operations.includes('count');
  const wantsList = operations.includes('list');

  if (wantsGet) {
    return executeGetOperation(validatedQuery, user, auth, deps);
  }

  const apiFilter = await resolveScopedApiFilter(validatedQuery, user, deps);
  const buildFilter = deps.buildEmployeeListMongoFilter ?? buildEmployeeListMongoFilter;
  const countFn = deps.countEmployeeCandidates ?? countEmployeeCandidates;
  const { mongoFilter } = await buildFilter(apiFilter);
  const statusIsAll = apiFilter.employmentStatus === 'all';

  let total = null;
  let employmentBreakdown = null;
  if (wantsCount || wantsList) {
    if (statusIsAll) {
      employmentBreakdown = await computeEmploymentBreakdown(apiFilter, deps);
      total = employmentBreakdown.total;
    } else {
      total = await countFn(mongoFilter);
    }
  }

  if (wantsCount && !wantsList) {
    return buildSuccessResult(validatedQuery, {
      provenance: 'employee.service.countEmployeeCandidates',
      total,
      records: [],
      ...(employmentBreakdown ? { employmentBreakdown } : {}),
    });
  }

  if (wantsList) {
    const listResult = await executeListOperation(
      validatedQuery,
      user,
      auth,
      apiFilter,
      total,
      deps
    );
    if (employmentBreakdown) {
      listResult.employmentBreakdown = employmentBreakdown;
    }
    return listResult;
  }

  return buildFailureResult(ERROR_CODES.VALIDATION, 'No supported operations requested.');
}
