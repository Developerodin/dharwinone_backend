/**
 * Epic C — Candidate hiring tunnel (referral leads) analytics helpers.
 *
 * Design constraint (per docs/superpowers/specs/2026-08-07-analytics-agent-core-design.md
 * §5): wrap `getReferralLeadsStats` / share the filter ideas already encoded in
 * `buildReferralLeadsMatch` — never invent a new funnel aggregator that could disagree
 * with the Refer Leads UI (referralLeads.service.js is the single source of truth for
 * the candidate/referral population).
 *
 * Hand-off note: this module answers the ATS / referral-lead population ONLY. The
 * Employee-role population (uses `employee_analytics` / `fetch_employees`) is a
 * SEPARATE population reached only after the User is granted the Employee role — see
 * `pipelineStatusToLifecycleStage` in referralPipelineStatus.js for the exact
 * hand-off point ('employee'). Do not merge the two in a chatbot answer.
 *
 * RBAC parity: the referral-leads HTTP routes (`GET /employees/referral-leads`,
 * `/referral-leads/stats`) are gated with `canReadCandidatesOnly` =
 * `requirePermissions('candidates.read')` (see src/routes/v1/employee.route.js).
 * This module enforces the SAME permission before touching referral-lead data.
 */

import { getUserPermissionContext } from '../permission.service.js';
import { getGrantingPermissions } from '../../config/permissions.js';
import { getReferralLeadsStats, listReferralLeads } from '../referralLeads.service.js';
import Placement from '../../models/placement.model.js';

/** Same permission the referral-leads HTTP routes require (canReadCandidatesOnly). */
export const REFERRAL_LEADS_READ_PERMISSION = 'candidates.read';

/**
 * True when the permission Set grants referral-leads read access (mirrors
 * requirePermissions('candidates.read') alias expansion).
 * @param {Set<string>|null|undefined} permissions
 * @returns {boolean}
 */
export function hasReferralLeadsReadAccess(permissions) {
  if (!permissions || typeof permissions.has !== 'function') return false;
  const granting = getGrantingPermissions(REFERRAL_LEADS_READ_PERMISSION);
  return granting.some((p) => permissions.has(p));
}

/**
 * Build a synthetic Express-like `req` for calling `getReferralLeadsStats` /
 * `buildReferralLeadsMatch` from the chatbot (no live HTTP request exists here).
 *
 * Permission loading mirrors the HTTP path (`auth()` → `getUserPermissionContext`)
 * exactly. Cheapest path: `auth()` middleware already stashes the computed
 * authContext on `req.user.authContext` (see middlewares/auth.js), so when the
 * chatbot is invoked from an authenticated request that is reused for free. A
 * plain `Set` can also be passed directly (e.g. from a test) to skip the DB call.
 *
 * @param {object} user - the acting user (chatAssistant fetchModule's `user` arg)
 * @param {object} [query] - query-string-shaped filters (from/to, referralContext, etc.)
 * @param {Set<string>} [permissions] - optional override, skips permission lookup
 * @returns {Promise<{ user: object, query: object, authContext: { isAdmin: boolean, permissions: Set<string> } }>}
 */
export async function buildSyntheticReferralReq(user, query = {}, permissions) {
  let authContext;
  if (permissions instanceof Set) {
    authContext = { isAdmin: false, permissions };
  } else if (user?.authContext?.permissions instanceof Set) {
    authContext = user.authContext;
  } else {
    authContext = await getUserPermissionContext(user);
  }
  return { user, query: query || {}, authContext };
}

/**
 * Provenance metadata for the pre-boarding bucket. Pre-boarding is docs/checklist
 * work tracked on `Placement.preBoardingStatus` — it is explicitly NOT one of the
 * linear `APPLICATION_STATUSES` steps (Applied/Screening/Interview/.../Hired). It
 * typically runs CONCURRENTLY with `Placement.status === 'Pending'` (offer accepted,
 * pre-boarding checklist running, before Onboarding/Joined) — so a chatbot funnel
 * must label it as a parallel track, never as "step 5 of 6" in a strict sequence.
 */
export const PRE_BOARDING_PROVENANCE = Object.freeze({
  source: 'Placement.preBoardingStatus',
  concurrent: true,
  linearApplicationStep: false,
  note:
    'Pre-boarding is tracked on Placement.preBoardingStatus (Pending|In Progress|Completed), ' +
    'NOT on APPLICATION_STATUSES. It runs concurrently with Placement.status=Pending — ' +
    'do not present it as a sequential stage after "offers".',
});

/**
 * Count candidates currently mid pre-boarding (Placement.preBoardingStatus is
 * Pending or In Progress — i.e. not yet Completed). Optionally scoped to a set of
 * candidate (Employee) ids, e.g. the referral leads currently in view.
 *
 * @param {{ companyEmpIds?: Array<string> }} [opts] - companyEmpIds: Employee/candidate
 *   _ids to scope the Placement.candidate lookup to (omit for company-wide).
 * @returns {Promise<{ count: number } & typeof PRE_BOARDING_PROVENANCE>}
 */
export async function countPreBoardingConcurrent({ companyEmpIds } = {}) {
  const ids = Array.isArray(companyEmpIds) ? companyEmpIds.filter(Boolean) : [];
  const match = { preBoardingStatus: { $in: ['Pending', 'In Progress'] } };
  if (ids.length) match.candidate = { $in: ids };
  const count = await Placement.countDocuments(match);
  return { count, ...PRE_BOARDING_PROVENANCE };
}

/**
 * Map a `getReferralLeadsStats` result into labeled hiring-tunnel buckets for the
 * chatbot. Pure function — no DB access, no LLM guessing. Every bucket carries a
 * `source` string identifying exactly which stats field it was derived from, so a
 * reviewer (or a future refactor) can trace disagreements back to the single
 * source of truth in referralLeads.service.js.
 *
 * Bucket vocabulary matches the Refer Leads `effectiveStatus` values (see
 * referralLeads.service.js buildEffectiveStatusStages / referralPipelineStatus.js):
 * pending, profile_complete, applied, interview, offer, preboarding, deferred,
 * hired, joined, employee, resigned, withdrawn, job_removed, rejected.
 *
 * @param {object} stats - result of referralLeads.service.js getReferralLeadsStats
 * @param {number} [stats.totalReferrals]
 * @param {Record<string, number>} [stats.pipelineCounts] - effectiveStatus → count
 * @returns {Record<string, { label: string, count: number, source: string, concurrent?: boolean }>}
 */
export function labelHiringTunnelBuckets(stats = {}) {
  const pipelineCounts = stats?.pipelineCounts || {};
  const num = (k) => Number(pipelineCounts[k] || 0);

  return {
    refer_leads: {
      label: 'Referral leads',
      count: Number(stats?.totalReferrals || 0),
      source: 'getReferralLeadsStats.totalReferrals',
    },
    applications: {
      label: 'Job applications',
      // "applied" is the effectiveStatus for a referral lead whose JobApplication
      // is at APPLICATION_STATUSES.Applied (or later, before interview/offer).
      count: num('applied'),
      source: 'pipelineCounts.applied',
    },
    interviews: {
      // in_review is a legacy stored value that is already normalized to
      // 'interview' by buildEffectiveStatusStages — both keys are summed defensively
      // in case an older/unnormalized snapshot is passed in.
      label: 'Interviews',
      count: num('interview') + num('in_review'),
      source: 'pipelineCounts.interview (+ legacy in_review alias)',
    },
    offers: {
      label: 'Offers',
      count: num('offer'),
      source: 'pipelineCounts.offer',
    },
    placements: {
      // Placement.status Onboarding maps to effectiveStatus 'hired'; Joined maps to
      // 'joined'; Deferred maps to 'deferred' — see deriveReferralPipelineStatus.
      label: 'Placements (Onboarding / Joined / Deferred)',
      count: num('hired') + num('joined') + num('deferred'),
      source: 'pipelineCounts.hired + pipelineCounts.joined + pipelineCounts.deferred',
    },
    pre_boarding: {
      // NOT a linear APPLICATION_STATUSES step — see PRE_BOARDING_PROVENANCE.
      label: 'Pre-boarding',
      count: num('preboarding'),
      concurrent: true,
      source: 'pipelineCounts.preboarding (Placement.status=Pending) — see PRE_BOARDING_PROVENANCE',
    },
    onboarded: {
      // The Employee-role hand-off. Distinct from Placement.Joined — see module
      // header hand-off note.
      label: 'Onboarded (Employee role)',
      count: num('employee'),
      source: 'pipelineCounts.employee — User granted Employee role',
    },
  };
}

/**
 * Orchestrator used by chatAssistant.service.js: enforces RBAC, calls
 * getReferralLeadsStats via a synthetic req, and labels the buckets.
 *
 * @param {object} opts
 * @param {object} opts.user
 * @param {object} [opts.query]
 * @param {Set<string>} [opts.permissions]
 * @returns {Promise<{ forbidden: true, reason: string } | object>}
 */
/**
 * Canonical referral-leads search for Sage — delegates to listReferralLeads (same as Referral Leads UI).
 *
 * @param {object} user
 * @param {object} [query] - ReferralLeadsQueryParams-shaped filters
 * @param {Set<string>} [permissions]
 * @returns {Promise<object>}
 */
export async function searchReferralLeads(user, query = {}, permissions) {
  if (!user) {
    return { forbidden: true, reason: 'No authenticated user' };
  }
  const req = await buildSyntheticReferralReq(user, query, permissions);
  if (user.platformSuperUser !== true && !hasReferralLeadsReadAccess(req.authContext.permissions)) {
    return { forbidden: true, reason: 'Missing candidates.read permission (referral leads)' };
  }
  return listReferralLeads(req);
}

export async function fetchHiringTunnelSnapshot({ user, query, permissions } = {}) {
  if (!user) {
    return { forbidden: true, reason: 'No authenticated user' };
  }
  const req = await buildSyntheticReferralReq(user, query, permissions);
  if (user.platformSuperUser !== true && !hasReferralLeadsReadAccess(req.authContext.permissions)) {
    return { forbidden: true, reason: 'Missing candidates.read permission (referral leads)' };
  }
  const stats = await getReferralLeadsStats(req);
  const buckets = labelHiringTunnelBuckets(stats);
  return {
    authoritative: true,
    population: 'referral_lead',
    stats,
    buckets,
  };
}
