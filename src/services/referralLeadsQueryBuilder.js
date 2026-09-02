import mongoose from 'mongoose';

export const DEFAULT_REFERRAL_LEADS_LIMIT = 25;
export const MAX_REFERRAL_LEADS_LIMIT = 100;

export function parseReferralLeadsPageLimit(query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_REFERRAL_LEADS_LIMIT, 1), MAX_REFERRAL_LEADS_LIMIT);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { page, limit };
}

/**
 * Count is the filtered total (before skip/limit). Invalid pages clamp to the last
 * valid page so `?page=999` does not return an empty table.
 */
export function resolveReferralLeadsPagination({ page, limit, total }) {
  const safeLimit = Math.min(Math.max(limit || DEFAULT_REFERRAL_LEADS_LIMIT, 1), MAX_REFERRAL_LEADS_LIMIT);
  const safeTotal = total || 0;
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit) || 1);
  const safePage = safeTotal === 0 ? 1 : Math.min(Math.max(1, page), totalPages);
  return {
    page: safePage,
    limit: safeLimit,
    total: safeTotal,
    totalPages,
    skip: (safePage - 1) * safeLimit,
  };
}

export function referralLeadsPaginationStages({ skip, limit }) {
  return [{ $skip: skip }, { $limit: limit }];
}

export function buildLeadMatchStage(filters = {}, scope = {}) {
  const match = {};
  if (scope.tenantId) match.tenantId = scope.tenantId;
  if (scope.salesAgentSelfScope && scope.userId) {
    match.currentSalesAgentUserId = scope.userId;
  }
  if (filters.salesAgentUserId && mongoose.Types.ObjectId.isValid(String(filters.salesAgentUserId))) {
    match.currentSalesAgentUserId = new mongoose.Types.ObjectId(String(filters.salesAgentUserId));
  }
  if (filters.unassigned === true || filters.unassigned === 'true') {
    match.currentSalesAgentUserId = null;
  }
  // hiredOnly / appliedOnly / employeeStatus are applied on computed effectiveStatus
  // in referralLeads.service (quickFilterEffectiveStatusMatch) so rows match the badge.
  if (filters.convertedEmployees === true || filters.convertedEmployees === 'true') {
    // Conversion is historical: include resigned employees (isActive=false) too.
    match.joiningDate = { $lte: new Date() };
  }
  return match;
}

export function applyNewFilters(query = {}) {
  return buildLeadMatchStage(query, {});
}

export function buildSalesAgentEnrichment() {
  return [
    {
      $lookup: {
        from: 'users',
        localField: 'currentSalesAgentUserId',
        foreignField: '_id',
        as: 'currentSalesAgent',
      },
    },
    { $unwind: { path: '$currentSalesAgent', preserveNullAndEmptyArrays: true } },
  ];
}

export function buildOfferEnrichment() {
  return [
    {
      $lookup: {
        from: 'offers',
        localField: '_id',
        foreignField: 'candidate',
        as: 'offers',
      },
    },
    {
      $set: {
        hasAcceptedOffer: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: '$offers',
                  as: 'o',
                  cond: { $eq: ['$$o.status', 'Accepted'] },
                },
              },
            },
            0,
          ],
        },
        hasAnyOffer: { $gt: [{ $size: '$offers' }, 0] },
      },
    },
  ];
}

export function buildLifecycleStageProjection() {
  return {
    $set: {
      // Legacy API field — derived from unified referralPipelineStatus (see pipelineStatusToLifecycleStage).
      lifecycleStage: {
        $switch: {
          branches: [
            { case: { $eq: ['$referralPipelineStatus', 'employee'] }, then: 'employee' },
            { case: { $eq: ['$referralPipelineStatus', 'resigned'] }, then: 'resigned' },
            { case: { $eq: ['$referralPipelineStatus', 'joined'] }, then: 'joined_pending_start' },
            {
              case: { $in: ['$referralPipelineStatus', ['preboarding', 'deferred', 'hired']] },
              then: 'preboarding',
            },
            { case: { $eq: ['$referralPipelineStatus', 'offer'] }, then: 'offered' },
            {
              case: { $in: ['$referralPipelineStatus', ['interview', 'in_review']] },
              then: 'interview',
            },
            {
              case: { $in: ['$referralPipelineStatus', ['applied', 'profile_complete']] },
              then: 'applied',
            },
          ],
          default: 'pending',
        },
      },
      employeeConverted: {
        $cond: [
          {
            $and: [{ $ne: ['$joiningDate', null] }, { $lte: ['$joiningDate', '$$NOW'] }],
          },
          true,
          { $in: ['$referralPipelineStatus', ['employee', 'resigned', 'joined']] },
        ],
      },
      employeeStatus: {
        $switch: {
          branches: [
            {
              case: {
                $and: [{ $ne: ['$joiningDate', null] }, { $lte: ['$joiningDate', '$$NOW'] }, { $eq: ['$isActive', true] }],
              },
              then: 'active',
            },
            {
              case: { $and: [{ $ne: ['$joiningDate', null] }, { $lte: ['$joiningDate', '$$NOW'] }] },
              then: 'resigned',
            },
          ],
          default: null,
        },
      },
    },
  };
}

export function buildCurrentAttributionIdEnrichment() {
  return [
    {
      $lookup: {
        from: 'referralattributions',
        let: { subjectId: '$_id', anchorJob: '$attributionJobId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$subjectProfileId', '$$subjectId'] },
                  { $eq: ['$isCurrent', true] },
                  { $eq: ['$isRevoked', false] },
                ],
              },
            },
          },
          {
            $addFields: {
              _pref: {
                $cond: [
                  {
                    $and: [{ $ne: ['$$anchorJob', null] }, { $eq: ['$jobId', '$$anchorJob'] }],
                  },
                  1,
                  0,
                ],
              },
            },
          },
          { $sort: { _pref: -1, assignedAt: -1, createdAt: -1 } },
          { $limit: 1 },
        ],
        as: '_currentAttr',
      },
    },
    { $set: { currentSalesAgentAttributionId: { $arrayElemAt: ['$_currentAttr._id', 0] } } },
    { $unset: ['_currentAttr', 'offers'] },
  ];
}

export function buildSalesAgentListEnrichmentStages() {
  return [
    buildLifecycleStageProjection(),
    ...buildSalesAgentEnrichment(),
    ...buildCurrentAttributionIdEnrichment(),
  ];
}
