/** Fields onboarding editors may mutate through PATCH /employees/candidate/:id */
export const ONBOARDING_PATCH_ALLOWLIST = new Set([
  'departmentId',
  'department',
  'designation',
  'position',
  'reportingManager',
  'employeeId',
  'shortBio',
  'degree',
]);

export const canFullEmployeeRecordEdit = (user) =>
  Boolean(user?.canManageCandidates || user?.canEditEmployees);

export const canOnboardingScopedEdit = (user) => Boolean(user?.canOnboardingEdit);

export const canMutateEmployeeRecord = (user, candidate) => {
  if (!candidate) return false;
  if (canFullEmployeeRecordEdit(user)) return true;
  if (canOnboardingScopedEdit(user)) return true;
  return String(candidate.owner) === String(user?.id || user?._id);
};

/** Strip PATCH body to onboarding-safe fields when caller lacks full edit rights. */
export const restrictToOnboardingPatchFields = (body) => {
  const out = {};
  for (const key of Object.keys(body || {})) {
    if (ONBOARDING_PATCH_ALLOWLIST.has(key)) out[key] = body[key];
  }
  return out;
};

/** Accepted-offer canonical sync requires elevated mutation rights. */
export const canSyncAcceptedOfferCanon = (user) => canFullEmployeeRecordEdit(user);

export default {
  ONBOARDING_PATCH_ALLOWLIST,
  canFullEmployeeRecordEdit,
  canOnboardingScopedEdit,
  canMutateEmployeeRecord,
  restrictToOnboardingPatchFields,
  canSyncAcceptedOfferCanon,
};
