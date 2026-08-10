import { getGrantingPermissions } from '../../config/permissions.js';
import { ERROR_CODES } from '../entityQuery.contract.js';

/** Mirror `employee.route.js` canReadEmployees + manage equivalents for chatbot entityQuery. */
const EMPLOYEE_QUERY_READ_PERMISSIONS = Object.freeze([
  'candidates.read',
  'employees.read',
  'candidates.manage',
  'employees.manage',
]);

/** Salary-bearing fields that exist on employee.model.js. `salaryRangeMin`/`Max`
 *  were listed here historically and are NOT model fields — removed so the list
 *  reflects reality. The allowlist in employeeQuery.projection.js is now the
 *  primary control; this remains as defence in depth. */
const SALARY_FIELD_KEYS = Object.freeze(['salaryRange', 'salarySlips']);

function permissionsSet(user) {
  return user?.authContext?.permissions;
}

function hasAnyPermission(permissions, requiredKeys) {
  if (!permissions) return false;
  return requiredKeys.some((required) => {
    const granting = getGrantingPermissions(required);
    return granting.some((p) => permissions.has(p));
  });
}

export function userHasEmployeeQueryAccess(user) {
  if (user?.platformSuperUser) return true;
  return hasAnyPermission(permissionsSet(user), EMPLOYEE_QUERY_READ_PERMISSIONS);
}

/** Spec: strip salary fields when caller lacks employees.manage. */
export function userCanViewEmployeeSalary(user) {
  if (user?.platformSuperUser) return true;
  return hasAnyPermission(permissionsSet(user), ['employees.manage']);
}

/** Filters that narrow to a single identifiable person. */
const IDENTITY_NARROWING_KEYS = ['search', 'fullName', 'email', 'employeeId', 'id'];
/** Attributes a masked-salary viewer must not be able to infer one-by-one. */
const GATED_INFERENCE_KEYS = ['compensationType'];

/**
 * Gate employee entityQuery before execution.
 *
 * @param {object} query - Validated StructuredQuery
 * @param {object} user - Authenticated user with authContext
 * @returns {{ allowed: true, maskSalaryFields: boolean } | { allowed: false, code: string, error: string }}
 */
export function authorizeEmployeeQuery(query, user) {
  if (!userHasEmployeeQueryAccess(user)) {
    return {
      allowed: false,
      code: ERROR_CODES.FORBIDDEN,
      error: 'You do not have permission to query employees.',
    };
  }

  const maskSalaryFields = !userCanViewEmployeeSalary(user);
  const filters = query?.filters ?? {};
  const narrowed = IDENTITY_NARROWING_KEYS.some((k) => filters[k]);
  const gated = GATED_INFERENCE_KEYS.some((k) => filters[k]);

  if (maskSalaryFields && narrowed && gated) {
    return {
      allowed: false,
      code: ERROR_CODES.FORBIDDEN,
      error: 'You do not have permission to view compensation details for a specific employee.',
    };
  }

  return { allowed: true, maskSalaryFields };
}

export function maskEmployeeRecord(record, maskSalaryFields) {
  if (!maskSalaryFields || !record || typeof record !== 'object') {
    return record;
  }

  const masked = { ...record };
  for (const key of SALARY_FIELD_KEYS) {
    delete masked[key];
  }
  return masked;
}

export function maskEmployeeRecords(records, maskSalaryFields) {
  if (!maskSalaryFields || !Array.isArray(records)) {
    return records;
  }
  return records.map((record) => maskEmployeeRecord(record, true));
}

export function stripSalaryFiltersFromQuery(filters) {
  if (!filters || typeof filters !== 'object') {
    return filters;
  }

  const next = { ...filters };
  for (const key of ['salaryRangeMin', 'salaryRangeMax']) {
    delete next[key];
  }
  return next;
}
