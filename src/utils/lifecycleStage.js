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

  if (employee.joiningDate) {
    const j = new Date(employee.joiningDate);
    if (j <= now) return employee.isActive ? 'employee' : 'resigned';
    return 'joined_pending_start';
  }
  if (acceptedOffer) return 'preboarding';
  if (anyOffer) return 'offered';
  if (employee.referralPipelineStatus === 'in_review' || hasInterview) return 'interview';
  if (['applied', 'profile_complete'].includes(employee.referralPipelineStatus)) return 'applied';
  return 'pending';
}
