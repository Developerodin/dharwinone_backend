// Record-side Employee role detection for chatbot table rendering.
//
// Employee ID cells/columns are shown ONLY when the record carries the
// Employee role (case-insensitive), OR — in explicit employee query
// contexts — when role metadata was not hydrated but employeeId was
// (name-search / Harsh Bansal path). A linked DBS code alone is never
// sufficient outside that employee listing context.

const roleNameFromRef = (x) => {
  if (x == null) return '';
  if (typeof x === 'object' && x.name) return String(x.name);
  return String(x);
};

/**
 * @param {object} record
 * @returns {string[]}
 */
export function roleNamesOf(record) {
  if (Array.isArray(record.roleNames) && record.roleNames.length) {
    return record.roleNames.map(String);
  }
  if (Array.isArray(record.roleIds) && record.roleIds.length) {
    return record.roleIds.map(roleNameFromRef).filter(Boolean);
  }
  if (Array.isArray(record.role) && record.role.length) {
    return record.role.map(roleNameFromRef).filter(Boolean);
  }
  if (record.role) return [roleNameFromRef(record.role)].filter(Boolean);
  return [];
}

/** @param {object} record */
export function pickEmployeeId(record) {
  return record.employeeId || record.empId || record.employee_code || '';
}

const EMPLOYEE_ROLE_RE = /^employee$/i;

/**
 * True when the record's role metadata includes Employee (any casing).
 * Multi-role: "Employee, Student" → true; "Administrator, Student" → false.
 *
 * @param {object} record
 * @returns {boolean}
 */
export function hasEmployeeRole(record) {
  return roleNamesOf(record).some((name) => EMPLOYEE_ROLE_RE.test(String(name).trim()));
}

const NON_EMPLOYEE_QUERY_ROLES = new Set([
  'administrator', 'administrators', 'admin',
  'agent', 'agents', 'salesagent', 'sales agent',
  'recruiter', 'recruiters',
  'candidate', 'candidates',
  'student', 'students',
  'mentor', 'mentors',
]);

/**
 * Whether a row should render an Employee ID cell.
 *
 * @param {object} record
 * @param {string|null|undefined} queryRole — listing context (requestedRole / data.role)
 * @returns {boolean}
 */
export function shouldShowEmployeeId(record, queryRole) {
  if (hasEmployeeRole(record)) return true;

  const q = String(queryRole || '').toLowerCase();
  if (NON_EMPLOYEE_QUERY_ROLES.has(q)) return false;

  // Name-search hydration: trust employeeId only in explicit employee listings.
  if ((q === 'employee' || q === 'employees') && pickEmployeeId(record)) return true;

  return false;
}
