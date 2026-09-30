import { queryActivityLogs as realQueryActivityLogs } from '../../../../activityLog.service.js';
import { ActivityActions, EntityTypes } from '../../../../../config/activityLog.js';
import { linkTypeLabel } from '../../../referralLeadFieldMap.js';
import { visibleUserStatusClause, canUserBeVisible } from '../../../visibilityRules.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import {
  REFERRAL_LEADS_ACCESS, hiringDeps, referralWindow, resolveLeadPerson, isSelfReference,
} from '../hiring/common.js';
import { personRecordsDeps, runPersonList as realRunPersonList } from '../employees/common.js';
import {
  getReferralLeadsStatsByAgent as realStatsByAgent,
  getReferralOpenStageAges as realStageAges,
  REFERRAL_OPEN_STAGES,
} from '../../../../referralLeads.service.js';
import { buildSyntheticReferralReq, hasReferralLeadsReadAccess } from '../../../referralLeadsAnalytics.js';

// Same gate as the Refer Leads page routes (employee.route.js canReadCandidatesOnly). Rows are then scoped by
// referralLeads.service canUserSeeAllReferralLeads: Sales Agents (and anyone without candidates.manage /
// interviews.manage) only ever see leads they referred or are the sales agent for.
export const REFERRALS_ACCESS = REFERRAL_LEADS_ACCESS;
export const MAX_LIST_LIMIT = 50;
export const NOT_CAPTURED = 'not captured in DharwinOne';
export const SHARES_NOT_CAPTURED = `WhatsApp shares and referral-link opens are ${NOT_CAPTURED}.`;

/** Fail closed: the referral services treat a missing user as unscoped, so no id means no call at all. */
export function referralsScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('referral tools need an authenticated user with an id');
  }
  return ctx.user;
}

/** Leads' referralJti (the signed link's id) — not on the shaped Refer Leads row. */
async function fetchReferralJtis(leadIds, Employee) {
  const rows = await Employee.find({ _id: { $in: leadIds } }).select('referralJti').lean();
  return new Map(rows.map((r) => [String(r._id), r.referralJti || null]));
}

const FORBIDDEN = Object.freeze({ forbidden: true, reason: 'Missing candidates.read permission (referral leads)' });

/**
 * Call a referralLeads.service function the way referralLeadsAnalytics fetchHiringTunnelSnapshot does: a
 * synthetic req carrying the viewer's permissions (so the service applies its own Sales Agent / scoped
 * row rule) behind the same candidates.read check the Refer Leads routes use.
 */
async function viaReferralReq(fn, user, query, ...rest) {
  const req = await buildSyntheticReferralReq(user, query);
  if (user.platformSuperUser !== true && !hasReferralLeadsReadAccess(req.authContext.permissions)) return FORBIDDEN;
  return fn(req, ...rest);
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function referralsDeps(ctx) {
  const d = ctx?.deps || {};
  const base = hiringDeps(ctx);
  return {
    ...base,
    queryActivityLogs: d.queryActivityLogs ?? realQueryActivityLogs,
    fetchReferralJtis: d.fetchReferralJtis ?? ((ids) => fetchReferralJtis(ids, base.Employee)),
    runPersonList: d.runPersonList ?? realRunPersonList,
    statsByAgent: d.statsByAgent ?? ((user, query, opts) => viaReferralReq(realStatsByAgent, user, query, opts)),
    stageAges: d.stageAges ?? ((user, query) => viaReferralReq(realStageAges, user, query)),
    referrerIdsFor: d.referrerIdsFor ?? (async (ids) => {
      const rows = await base.Employee.find({ _id: { $in: ids } }).select('referredByUserId').lean();
      return new Set(rows.filter((r) => r.referredByUserId).map((r) => String(r._id)));
    }),
    personDeps: personRecordsDeps(ctx),
    now: d.now ?? (() => new Date()),
  };
}

export { referralWindow, resolveLeadPerson, isSelfReference };

/**
 * Who issued the signed link a lead claimed: the referral.link.issued ActivityLog row whose entityId is the
 * lead's referralJti, read through activityLog.service queryActivityLogs with the viewer (hidden actors stay
 * hidden). Onboarding invites, backfilled referrals and links from before auditing have no such row → null.
 */
export async function linkIssuedFor(jti, user, deps) {
  if (!jti) return null;
  const res = await deps.queryActivityLogs(
    { action: ActivityActions.REFERRAL_LINK_ISSUED, entityType: EntityTypes.REFERRAL, entityId: jti },
    { limit: 1, page: 1 },
    user,
  );
  const row = res?.results?.[0];
  if (!row) return null;
  return { issuedBy: row.actor?.name ?? null, issuedAt: row.createdAt ?? null };
}

/** One Refer Leads row → the referral facts get_referral reports. */
export function referralRow(r) {
  const o = r.referralLastOverride;
  return {
    leadId: String(r.id ?? r._id ?? ''),
    candidate: r.fullName ?? null,
    email: r.email ?? null,
    referred: true,
    referredBy: r.referredBy?.name ?? null,
    salesAgent: r.salesAgent?.name ?? null,
    salesAgentAssignedAt: r.salesAgentAssignedAt ?? null,
    attributionId: r.salesAgentCurrentAttributionId ?? null,
    channel: linkTypeLabel(r.referralContext),
    job: r.job?.title ?? null,
    referredAt: r.referredAt ?? null,
    batchId: r.referralBatchId ?? null,
    status: r.referralPipelineStatus ?? null,
    attributionOverride: o
      ? {
        previousReferredBy: o.previousReferredBy?.name ?? null,
        overriddenBy: o.overriddenByUser?.name ?? null,
        overriddenAt: o.overriddenAt ?? null,
        reason: o.reason || null,
      }
      : null,
  };
}

// Buckets over the Refer Leads effectiveStatus values (referralLeads.service buildEffectiveStatusStages).
const NEVER_APPLIED = ['pending', 'profile_complete'];
const IN_PIPELINE = ['applied', 'in_review', 'interview', 'offer', 'preboarding', 'deferred', 'hired'];
const OFFER_OR_LATER = ['offer', 'preboarding', 'deferred', 'hired', 'joined', 'employee', 'resigned'];
const JOINED = ['joined', 'employee', 'resigned'];
export const OPEN_STAGES = REFERRAL_OPEN_STAGES;

export const STAGE_ENTRY_BASIS =
  'Days in stage run from the record that put the lead there: applied = first application still at Applied; ' +
  'interview = first interview scheduled (not cancelled); offer = first open offer created; pre-boarding = ' +
  'placement created (or offer accepted); deferred = deferral date; onboarding = onboarding start. Leads whose ' +
  'record has no such date (older data, or an interview stage set from the application status alone) are ' +
  'counted but not in the day figures — leadsWithStageDate says how many had one.';

export const METRIC_DEFINITIONS = Object.freeze({
  applied: 'referred minus never applied (includes later withdrawn, rejected and job-removed leads)',
  neverApplied: 'still pending or profile complete',
  active: 'in the pipeline now: applied, interview, offer, pre-boarding, deferred or onboarding',
  offers: 'reached an offer or any later stage',
  joined: 'joined, now an employee, or joined and since resigned',
  joinRatePercent: 'joined ÷ referred',
  pageConversionPercent: 'the Refer Leads page conversion card: share that moved past pending',
});

const sumOf = (counts, keys) => keys.reduce((s, k) => s + Number(counts[k] || 0), 0);
const round1 = (n) => Math.round(n * 10) / 10;

/** getReferralLeadsStats (via fetchHiringTunnelSnapshot) → the counts get_referral_stats reports. */
export function referralMetrics(stats = {}) {
  const c = stats.pipelineCounts || {};
  const referred = Number(stats.totalReferrals || 0);
  const neverApplied = sumOf(c, NEVER_APPLIED);
  const joined = sumOf(c, JOINED);
  return {
    referred,
    applied: referred - neverApplied,
    neverApplied,
    active: sumOf(c, IN_PIPELINE),
    offers: sumOf(c, OFFER_OR_LATER),
    joined,
    rejected: Number(c.rejected || 0),
    withdrawn: Number(c.withdrawn || 0),
    joinRatePercent: referred > 0 ? round1((joined / referred) * 100) : null,
    pageConversionPercent: stats.conversionRate ?? null,
  };
}

/**
 * This IST month so far and the whole previous month, as { from, to } YYYY-MM-DD days.
 * @param {Date} now
 */
export function monthWindows(now) {
  const today = dateStrInTz(now, DEFAULT_TIMEZONE);
  const thisStart = `${today.slice(0, 8)}01`;
  const lastEnd = addDaysToDateStr(thisStart, -1);
  return {
    thisMonth: { from: thisStart, to: today },
    lastMonth: { from: `${lastEnd.slice(0, 8)}01`, to: lastEnd },
  };
}

/**
 * Sales agents who hold at least one referral lead, with visible names. Same distinct the hiring domain's
 * resolveLeadPerson runs, plus the directory visibility rules.
 * ponytail: one distinct over every referral lead; fine while leads stay in the tens of thousands.
 */
export async function listLeadSalesAgents(viewer, deps) {
  const ids = await deps.Employee.distinct('currentSalesAgentUserId', {
    referredByUserId: { $exists: true, $ne: null },
    currentSalesAgentUserId: { $ne: null },
  });
  if (!ids?.length) return [];
  const users = await deps.User.find({ _id: { $in: ids }, status: visibleUserStatusClause() })
    .select('_id name status platformSuperUser')
    .lean();
  return users
    .filter((u) => viewer?.platformSuperUser || canUserBeVisible(u))
    .map((u) => ({ id: String(u._id), name: u.name ?? null }));
}
