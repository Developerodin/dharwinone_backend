/**
 * Canonical Referral Lead field map — mirrors Employee (candidates) schema + shaped list row.
 * Single source of truth for Sage referral-lead queries (same population as Referral Leads UI).
 */
export const REFERRAL_LEAD_FIELD_MAP = Object.freeze({
  /** Mongo collection backing referral leads (Employee model). */
  collection: 'candidates',
  /** Candidate document id (Employee._id). */
  id: 'id',
  candidateName: 'fullName',
  candidateEmail: 'email',
  /** User who shared the referral link / referred this candidate. */
  referredBy: 'referredByUserId',
  /** Assigned sales agent (NOT internal Agent role — see agentEmployeeRelation.js). */
  assignedSalesAgent: 'currentSalesAgentUserId',
  /** Link type: JOB_APPLY | SHARE_CANDIDATE_ONBOARD. */
  linkType: 'referralContext',
  jobId: 'referralJobId',
  jobTitle: 'referralJobTitle',
  /** Pipeline status (effectiveStatus in list UI). */
  status: 'referralPipelineStatus',
  /** When the referral was claimed / attributed (user-facing "claimedAt"). */
  claimedAt: 'referredAt',
  salesAgentAssignedAt: 'currentSalesAgentAssignedAt',
  attributionLockedAt: 'attributionLockedAt',
});

/** UI link-type labels ↔ stored referralContext enum. */
export const REFERRAL_LINK_TYPE = Object.freeze({
  JOB_APPLY: 'job_link',
  SHARE_CANDIDATE_ONBOARD: 'onboard_invite',
});

/** Stored referralPipelineStatus values (Employee schema enum + effective overlays). */
export const REFERRAL_PIPELINE_STATUSES = Object.freeze([
  'profile_complete',
  'pending',
  'applied',
  'in_review',
  'interview',
  'offer',
  'preboarding',
  'deferred',
  'hired',
  'joined',
  'employee',
  'resigned',
  'rejected',
  'withdrawn',
  'job_removed',
]);

export function linkTypeLabel(referralContext) {
  if (referralContext === 'JOB_APPLY') return 'Job link';
  if (referralContext === 'SHARE_CANDIDATE_ONBOARD') return 'Onboard invite';
  return null;
}
