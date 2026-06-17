export function isActiveEmployee(employee, opts = {}) {
  const now = opts.now ?? new Date();
  if (!employee?.joiningDate || employee.isActive !== true) return false;
  return new Date(employee.joiningDate) <= now;
}

/** 'active' | 'resigned' for converted employees (joining date passed), else null. */
export function deriveEmployeeStatus(employee, opts = {}) {
  const now = opts.now ?? new Date();
  if (!employee?.joiningDate || new Date(employee.joiningDate) > now) return null;
  return employee.isActive === true ? 'active' : 'resigned';
}

export function deriveLifecycleStage(employee, opts = {}) {
  const now = opts.now ?? new Date();
  const acceptedOffer = opts.acceptedOffer === true;
  const anyOffer = opts.anyOffer === true;
  const hasInterview = opts.hasInterview === true;
  const status = employee.referralPipelineStatus;
  const isHired = status === 'hired';

  // Being a current employee / awaiting-start requires a CONFIRMED hire (pipeline status
  // 'hired'). A joiningDate alone is not enough — an applied candidate that happens to carry
  // a joiningDate must still read as its hiring-cycle stage, not 'Employee'.
  if (employee.joiningDate) {
    const j = new Date(employee.joiningDate);
    // Resignation is a factual post-join state: joined then deactivated, regardless of status.
    if (j <= now && employee.isActive !== true) return 'resigned';
    if (isHired) {
      if (j <= now) return 'employee';
      return 'joined_pending_start';
    }
    // joiningDate set but not yet hired → fall through to the hiring-cycle stages below.
  }
  if (acceptedOffer) return 'preboarding';
  if (anyOffer) return 'offered';
  if (status === 'in_review' || hasInterview) return 'interview';
  if (['applied', 'profile_complete'].includes(status)) return 'applied';
  return 'pending';
}
