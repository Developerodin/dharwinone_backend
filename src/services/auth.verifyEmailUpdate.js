/**
 * Pure builders for verify-email persistence (unit-tested).
 * RoleIds are applied via a single aggregation-pipeline $set so Student→Candidate swap is atomic in MongoDB.
 * (Using `$pull` + `$addToSet` on the same field in one update often conflicts.)
 *
 * @param {{ status: string, eligibleForCandidateAutoActivate: boolean, setRegistrationSourcePublicCandidate?: boolean, roleIds?: unknown[] }} user
 * @param {{ skipStaffAutoActivate: boolean, candidateRoleId: import('mongoose').Types.ObjectId|string|null, studentRoleId?: import('mongoose').Types.ObjectId|string|null }} opts
 * @returns {{
 *   pendingToActive: boolean,
 *   applyRoleIdsInDb: boolean,
 *   scalarSet: Record<string, unknown>,
 *   studentRoleId: import('mongoose').Types.ObjectId|string|null,
 *   candidateRoleId: import('mongoose').Types.ObjectId|string|null,
 * }}
 */
export const buildVerifyEmailUpdatePlan = (user, opts) => {
  const { skipStaffAutoActivate, candidateRoleId, studentRoleId } = opts;
  const eligible = user.eligibleForCandidateAutoActivate === true;

  const emptyPlan = {
    pendingToActive: false,
    applyRoleIdsInDb: false,
    scalarSet: { isEmailVerified: true },
    studentRoleId: null,
    candidateRoleId: null,
  };

  if (skipStaffAutoActivate) {
    return emptyPlan;
  }

  if (!eligible) {
    return emptyPlan;
  }

  if (user.status === 'disabled' || user.status === 'deleted') {
    return emptyPlan;
  }

  const wasPending = user.status === 'pending';
  const scalarSet = { isEmailVerified: true };
  if (wasPending) {
    scalarSet.status = 'active';
  }
  if (user.setRegistrationSourcePublicCandidate) {
    scalarSet.registrationSource = 'public_candidate';
  }

  return {
    pendingToActive: wasPending,
    applyRoleIdsInDb: candidateRoleId != null,
    scalarSet,
    studentRoleId: studentRoleId || null,
    candidateRoleId: candidateRoleId || null,
  };
};

/**
 * One-stage aggregation pipeline: atomic roleIds merge + scalar fields from `plan.scalarSet`.
 * @param {ReturnType<typeof buildVerifyEmailUpdatePlan>} plan
 * @returns {object[]|null} null when pipeline is not needed
 */
export const buildVerifyEmailAggregationPipeline = (plan) => {
  if (!plan.applyRoleIdsInDb || !plan.candidateRoleId) {
    return null;
  }
  const studentOid = plan.studentRoleId || null;
  const candidateOid = plan.candidateRoleId;

  const roleExpr = studentOid
    ? {
        $let: {
          vars: {
            stripped: {
              $filter: {
                input: { $ifNull: ['$roleIds', []] },
                as: 'r',
                cond: { $ne: ['$$r', studentOid] },
              },
            },
          },
          in: {
            $cond: [
              { $in: [candidateOid, '$$stripped'] },
              '$$stripped',
              { $concatArrays: ['$$stripped', [candidateOid]] },
            ],
          },
        },
      }
    : {
        $cond: [
          { $in: [candidateOid, { $ifNull: ['$roleIds', []] }] },
          { $ifNull: ['$roleIds', []] },
          { $concatArrays: [{ $ifNull: ['$roleIds', []] }, [candidateOid]] },
        ],
      };

  return [
    {
      $set: {
        roleIds: roleExpr,
        ...plan.scalarSet,
      },
    },
  ];
};
