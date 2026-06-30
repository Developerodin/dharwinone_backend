// Referral-pipeline statuses that mean the person actually became staff (present or past).
// Deliberately NARROW: 'applied'/'interview'/'offer'/'hired'/'preboarding' are still the external
// hire pipeline (no employeeId yet), NOT existing employees. Only joined/active/resigned count.
const EMPLOYEE_PIPELINE_STATUSES = new Set(['employee', 'joined', 'resigned']);

/**
 * True if this person is (or has been) an actual employee — they hold a permanent `employeeId`,
 * or their referral pipeline reached a staff state (employee / joined / resigned).
 *
 * Used to route post-interview handling: an existing employee goes through INTERNAL TRANSFER
 * (update the same record, no new offer/placement, keep employeeId); everyone else is an external hire.
 */
export const isExistingEmployee = (employee) => {
  if (!employee) return false;
  if (employee.employeeId && String(employee.employeeId).trim()) return true;
  return EMPLOYEE_PIPELINE_STATUSES.has(String(employee.referralPipelineStatus || ''));
};

/**
 * A resigned / inactive former employee re-applying is a REHIRE, not a transfer.
 * They must use the external hire flow, never the internal-transfer path.
 */
export const isResignedEmployee = (employee) => {
  if (!employee) return false;
  return employee.referralPipelineStatus === 'resigned' || employee.isActive === false;
};
