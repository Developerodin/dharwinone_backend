/**
 * Normalize role id for Set keys (Mongo update accepts same shape back on User.roleIds).
 * @param {unknown} id
 * @returns {string}
 */
const roleIdKey = (id) => (id != null && typeof id === 'object' && 'toString' in id ? id.toString() : String(id));

/**
 * Pure builder for Mongo update used by verifyEmail (unit-tested).
 * MongoDB rejects the same update using both `$addToSet` and `$pull` on `roleIds` ("conflict at roleIds").
 * We merge role ids in one `$set.roleIds` instead.
 *
 * @param {{ status: string, eligibleForCandidateAutoActivate: boolean, setRegistrationSourcePublicCandidate?: boolean, roleIds?: unknown[] }} user
 * @param {{ skipStaffAutoActivate: boolean, candidateRoleId: import('mongoose').Types.ObjectId|string|null, studentRoleId?: import('mongoose').Types.ObjectId|string|null }} opts
 * @returns {{ mongoUpdate: { $set: object }, pendingToActive: boolean }}
 */
export const buildVerifyEmailMongoUpdate = (user, opts) => {
  const { skipStaffAutoActivate, candidateRoleId, studentRoleId } = opts;
  const eligible = user.eligibleForCandidateAutoActivate === true;

  if (skipStaffAutoActivate) {
    return { mongoUpdate: { $set: { isEmailVerified: true } }, pendingToActive: false };
  }

  if (!eligible) {
    return { mongoUpdate: { $set: { isEmailVerified: true } }, pendingToActive: false };
  }

  if (user.status === 'disabled' || user.status === 'deleted') {
    return { mongoUpdate: { $set: { isEmailVerified: true } }, pendingToActive: false };
  }

  const wasPending = user.status === 'pending';
  const set = { isEmailVerified: true };
  if (wasPending) {
    set.status = 'active';
  }
  if (user.setRegistrationSourcePublicCandidate) {
    set.registrationSource = 'public_candidate';
  }

  const merged = new Set((user.roleIds || []).map(roleIdKey));
  if (studentRoleId != null) {
    merged.delete(roleIdKey(studentRoleId));
  }
  if (candidateRoleId != null) {
    merged.add(roleIdKey(candidateRoleId));
  }
  set.roleIds = [...merged];

  return { mongoUpdate: { $set: set }, pendingToActive: wasPending };
};
