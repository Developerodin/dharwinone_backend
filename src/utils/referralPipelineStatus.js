/**
 * Derive stored `referralPipelineStatus` from ATS source-of-truth entities.
 * Precedence: post-join lifecycle → placement → offer → interview → application.
 */

const OPEN_OFFER_STATUSES = new Set(['Draft', 'Sent', 'Under Negotiation']);

const PLACEMENT_RANK = {
  Joined: 5,
  Onboarding: 4,
  Pending: 3,
  Deferred: 2,
  Cancelled: 1,
};

const APP_RANK = {
  Hired: 6,
  Offered: 5,
  Interview: 4,
  Screening: 3,
  Applied: 2,
  Rejected: 1,
};

const TERMINAL_META = new Set(['withdrawn', 'job_removed']);

export const PIPELINE_PROGRESS_STATUSES = [
  'applied',
  'interview',
  'in_review',
  'offer',
  'preboarding',
  'deferred',
  'hired',
  'joined',
  'employee',
];

export const CONVERTED_PIPELINE_STATUSES = [
  ...PIPELINE_PROGRESS_STATUSES,
  'resigned',
];

export const PENDING_PIPELINE_STATUSES = ['pending', 'profile_complete'];

function pickPrimaryPlacement(placements) {
  if (!placements?.length) return null;
  return [...placements].sort((a, b) => {
    const ra = PLACEMENT_RANK[a.status] ?? 0;
    const rb = PLACEMENT_RANK[b.status] ?? 0;
    if (rb !== ra) return rb - ra;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  })[0];
}

function pickPrimaryApplication(apps) {
  if (!apps?.length) return null;
  return [...apps].sort((a, b) => {
    const ra = APP_RANK[a.status] ?? 0;
    const rb = APP_RANK[b.status] ?? 0;
    if (rb !== ra) return rb - ra;
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  })[0];
}

function hasPendingInterview(meetings) {
  return (meetings || []).some(
    (m) => m.status !== 'cancelled' && (m.interviewResult === 'pending' || !m.interviewResult)
  );
}

function hasInterviewRejection(meetings) {
  return (meetings || []).some((m) => m.interviewResult === 'rejected');
}

function hasSelectedInterview(meetings) {
  return (meetings || []).some((m) => m.status !== 'cancelled' && m.interviewResult === 'selected');
}

function hasOpenOffer(offers) {
  return (offers || []).some((o) => OPEN_OFFER_STATUSES.has(o.status));
}

function hasAcceptedOffer(offers) {
  return (offers || []).some((o) => o.status === 'Accepted');
}

function hasOfferRejection(offers) {
  return (offers || []).some((o) => o.status === 'Rejected');
}

/**
 * @param {object} ctx
 * @param {object} [ctx.employee] - lean Employee
 * @param {object[]} [ctx.apps]
 * @param {object[]} [ctx.placements]
 * @param {object[]} [ctx.offers]
 * @param {object[]} [ctx.meetings]
 * @param {Date} [ctx.now]
 * @returns {string|null} next referralPipelineStatus, or null to keep idle meta (pending/profile_complete)
 */
export function deriveReferralPipelineStatus(ctx) {
  const { employee, apps = [], placements = [], offers = [], meetings = [] } = ctx;
  const now = ctx.now ?? new Date();

  if (employee?.joiningDate) {
    const j = new Date(employee.joiningDate);
    if (!Number.isNaN(j.getTime()) && j <= now) {
      return employee.isActive === true ? 'employee' : 'resigned';
    }
  }

  const placement = pickPrimaryPlacement(placements);
  if (placement?.status === 'Cancelled') return 'rejected';
  if (placement?.status === 'Deferred') return 'deferred';
  if (placement?.status === 'Onboarding') return 'hired';
  if (placement?.status === 'Joined') return 'joined';
  if (placement?.status === 'Pending') return 'preboarding';

  if (hasAcceptedOffer(offers)) return 'preboarding';
  if (hasOpenOffer(offers)) return 'offer';

  const primaryApp = pickPrimaryApplication(apps);
  if (primaryApp?.status === 'Rejected' && apps.every((a) => a.status === 'Rejected')) {
    return 'rejected';
  }
  if (hasOfferRejection(offers) && !hasOpenOffer(offers) && !hasAcceptedOffer(offers)) {
    if (!primaryApp || primaryApp.status === 'Rejected') return 'rejected';
  }
  if (hasInterviewRejection(meetings) && !hasOpenOffer(offers) && !hasAcceptedOffer(offers)) {
    if (!primaryApp || ['Rejected', 'Applied', 'Screening'].includes(primaryApp.status)) {
      return 'rejected';
    }
  }

  if (hasPendingInterview(meetings)) return 'interview';
  // Interview decided 'selected' → next stage is Offer, even before an offer entity exists.
  if (hasSelectedInterview(meetings)) return 'offer';
  if (primaryApp && ['Interview', 'Screening'].includes(primaryApp.status)) return 'interview';

  if (primaryApp?.status === 'Hired' || primaryApp?.status === 'Offered') return 'offer';
  if (primaryApp?.status === 'Applied') return 'applied';
  if (apps.length && apps.every((a) => a.status === 'Rejected')) return 'rejected';

  return null;
}

/** Map stored pipeline status → legacy lifecycleStage for API consumers. */
export function pipelineStatusToLifecycleStage(status) {
  switch (status) {
    case 'applied':
    case 'profile_complete':
      return 'applied';
    case 'interview':
    case 'in_review':
      return 'interview';
    case 'offer':
      return 'offered';
    case 'preboarding':
    case 'deferred':
    case 'hired':
      return 'preboarding';
    case 'joined':
      return 'joined_pending_start';
    case 'employee':
      return 'employee';
    case 'resigned':
      return 'resigned';
    default:
      return 'pending';
  }
}

export function isTerminalMetaStatus(status) {
  return TERMINAL_META.has(status);
}
