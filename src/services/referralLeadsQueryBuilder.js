import mongoose from 'mongoose';

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
  if (filters.hiredOnly === true || filters.hiredOnly === 'true') {
    match.referralPipelineStatus = 'hired';
  }
  if (filters.pendingReferrals === true || filters.pendingReferrals === 'true') {
    match.referralPipelineStatus = { $in: ['pending', 'profile_complete', 'applied', 'in_review'] };
  }
  if (filters.convertedEmployees === true || filters.convertedEmployees === 'true') {
    // Conversion is historical: include resigned employees (isActive=false) too.
    match.joiningDate = { $lte: new Date() };
  }
  if (filters.employeeStatus === 'active') {
    match.joiningDate = { $lte: new Date() };
    match.isActive = true;
  } else if (filters.employeeStatus === 'resigned') {
    match.joiningDate = { $lte: new Date() };
    match.isActive = { $ne: true };
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
      lifecycleStage: {
        $switch: {
          branches: [
            {
              case: {
                $and: [{ $ne: ['$joiningDate', null] }, { $lte: ['$joiningDate', '$$NOW'] }, { $eq: ['$isActive', true] }],
              },
              then: 'employee',
            },
            {
              case: {
                $and: [{ $ne: ['$joiningDate', null] }, { $lte: ['$joiningDate', '$$NOW'] }, { $ne: ['$isActive', true] }],
              },
              then: 'resigned',
            },
            {
              case: { $and: [{ $ne: ['$joiningDate', null] }, { $gt: ['$joiningDate', '$$NOW'] }] },
              then: 'joined_pending_start',
            },
            { case: { $eq: ['$hasAcceptedOffer', true] }, then: 'preboarding' },
            { case: { $eq: ['$hasAnyOffer', true] }, then: 'offered' },
            { case: { $eq: ['$referralPipelineStatus', 'in_review'] }, then: 'interview' },
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
            // Conversion is a historical fact — stays true after resignation.
            $and: [{ $ne: ['$joiningDate', null] }, { $lte: ['$joiningDate', '$$NOW'] }],
          },
          true,
          false,
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
    ...buildOfferEnrichment(),
    buildLifecycleStageProjection(),
    ...buildSalesAgentEnrichment(),
    ...buildCurrentAttributionIdEnrichment(),
  ];
}
