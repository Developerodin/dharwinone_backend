/**
 * Allowlist projection for employee records leaving the entityQuery pipeline.
 *
 * This is a SECURITY control, not a presentation concern. A blocklist has to
 * enumerate every sensitive field that will ever exist; this enumerates the few
 * that are safe. Adding a field here is a deliberate disclosure decision.
 *
 * Derived from the fields the deterministic table renderer consumes
 * (src/services/chatAssistant/renderers/employees.js) plus the fields the
 * follow-up context needs (saveEmployeeQueryContext.js).
 */
export const EMPLOYEE_RECORD_ALLOWLIST = new Set([
  '_id',
  'fullName',
  'employeeId',
  'email',
  'joiningDate',
  'joinDate', // mapEntityQueryEmployeeRecord legacy join field
  'resignDate',
  'resignationDate', // mapEntityQueryEmployeeRecord legacy resign field
  'employmentState',
  'compensationType',
  'department',
  'designation',
  'position', // mapEntityQueryEmployeeRecord department fallback
  'isActive',
  'ownerStatus', // mapEntityQueryEmployeeRecord accountState column
  'status', // mapEntityQueryEmployeeRecord accountState fallback
]);

/**
 * @param {object|null} record
 * @returns {object|null}
 */
export function projectEmployeeRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const out = {};
  for (const key of EMPLOYEE_RECORD_ALLOWLIST) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/**
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
export function projectEmployeeRecords(records) {
  if (!Array.isArray(records)) return records;
  return records.map(projectEmployeeRecord);
}
