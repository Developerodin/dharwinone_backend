import UserModel from '../../../../../models/user.model.js';
import EmployeeModel from '../../../../../models/employee.model.js';
import { queryMeetings as realQueryMeetings } from '../../../../meeting.service.js';
import { queryOffers as realQueryOffers } from '../../../../offer.service.js';
import {
  queryPlacements as realQueryPlacements,
  PRE_BOARDING_QUEUE_STATUSES,
  ONBOARDING_ACTIVE_STATUSES,
  STAGE_OFFRAMP_STATUSES,
} from '../../../../placement.service.js';
import { canUserSeeAllReferralLeads } from '../../../../referralLeads.service.js';
import {
  fetchHiringTunnelSnapshot as realFetchHiringTunnelSnapshot,
  searchReferralLeads as realSearchReferralLeads,
  buildSyntheticReferralReq,
} from '../../../referralLeadsAnalytics.js';
import { linkTypeLabel } from '../../../referralLeadFieldMap.js';
import { buildMeetingsMongoFilter } from '../../../../../utils/meetingQueryFilter.js';
import { visibleUserStatusClause, canUserBeVisible } from '../../../visibilityRules.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { dayRange, dayWindowBounds } from '../employees/common.js';

// Each constant mirrors the GET route of the page the tools read, so a chat answer never exceeds the page.
// meeting.route.js GET / — rows then scoped by meetingScope (interviews manage = all, read = own).
export const INTERVIEWS_ACCESS = Object.freeze({
  anyOf: ['interviews.read'],
  note: 'rows scoped by meetingScope in queryMeetings',
});
// offer.route.js canReadOffers
export const OFFERS_ACCESS = Object.freeze({
  anyOf: [
    'candidates.read', 'employees.read',
    'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
    'pre-boarding.read', 'pre-boarding.edit', 'pre-boarding.manage',
  ],
});
// placement.route.js canReadPlacements
export const PLACEMENTS_ACCESS = Object.freeze({
  anyOf: [
    'candidates.read',
    'pre-boarding.read', 'pre-boarding.create', 'pre-boarding.edit', 'pre-boarding.delete', 'pre-boarding.manage',
    'onboarding.read', 'onboarding.create', 'onboarding.edit', 'onboarding.delete', 'onboarding.manage',
    'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
  ],
});
// employee.route.js canReadCandidatesOnly (GET /employees/referral-leads and /referral-leads/stats).
export const REFERRAL_LEADS_ACCESS = Object.freeze({ anyOf: ['candidates.read'] });

// B1: the Offers page shows compensation only in the Offer Letter Generator (ats.offers edit), whose
// server gate is offer.route.js canEditOffers. Everyone else who can read offers sees no CTC.
const OFFER_COMPENSATION_RULE = Object.freeze({
  anyOf: ['candidates.manage', 'employees.edit', 'offers.edit', 'offers.manage'],
});

export const MAX_LIST_LIMIT = 50;

// Placement statuses the page's stage queues accept as a narrowing status (placement.service applyStageFilter).
// A status outside the stage makes the service fall back to the whole stage, so a breakdown must skip it.
const STAGE_STATUSES = Object.freeze({
  preBoarding: [...PRE_BOARDING_QUEUE_STATUSES],
  onboarding: [...ONBOARDING_ACTIVE_STATUSES, ...STAGE_OFFRAMP_STATUSES],
});
// Legacy parity: Cancelled placements are left out unless asked for.
const DEFAULT_PLACEMENT_STATUSES = 'Pending,Onboarding,Joined,Deferred';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fail closed: the services treat a missing user as unscoped, so no id means no call at all. */
export function hiringScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('hiring tools need an authenticated user with an id');
  }
  return ctx.user;
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function hiringDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    queryMeetings: deps.queryMeetings ?? realQueryMeetings,
    queryOffers: deps.queryOffers ?? realQueryOffers,
    queryPlacements: deps.queryPlacements ?? realQueryPlacements,
    fetchHiringTunnelSnapshot: deps.fetchHiringTunnelSnapshot ?? realFetchHiringTunnelSnapshot,
    searchReferralLeads: deps.searchReferralLeads ?? realSearchReferralLeads,
    canSeeAllReferralLeads: deps.canSeeAllReferralLeads
      ?? (async (user) => canUserSeeAllReferralLeads(await buildSyntheticReferralReq(user, {}))),
    User: deps.User ?? UserModel,
    Employee: deps.Employee ?? EmployeeModel,
  };
}

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * One limit-1 service call per bucket, so every number is the page's own count (plan D2).
 * ponytail: 1 + buckets small count queries per count call (<= 8 here); if that ever shows in latency,
 * add a grouped count to the service instead of re-implementing its filters here.
 */
export async function countByBuckets(countFor, values) {
  const totals = await Promise.all(values.map((v) => countFor(v)));
  return Object.fromEntries(values.map((v, i) => [v, totals[i]]));
}

// ─── Interviews ─────────────────────────────────────────────────────────────

/**
 * The Interviews page filter (buildMeetingsMongoFilter: candidate, status, scheduledAt window) plus two
 * clauses the page has no control for: interviewer = recruiter OR any panel agent, and interviewResult.
 */
export function interviewMongoFilter(filters = {}) {
  const base = buildMeetingsMongoFilter(compact({
    candidate: filters.candidate,
    status: filters.status,
    ...dayRange('date', filters.scheduledBetween),
  }));
  const and = [...(base.$and || [])];
  if (filters.interviewer) {
    const re = { $regex: escapeRegex(filters.interviewer), $options: 'i' };
    and.push({ $or: [{ 'recruiter.name': re }, { 'agents.name': re }] });
  }
  if (filters.jobPosition) and.push({ jobPosition: { $regex: escapeRegex(filters.jobPosition), $options: 'i' } });
  if (filters.result) and.push({ interviewResult: filters.result });
  return and.length ? { $and: and } : {};
}

/** "Name (recruiter), Panel A, Panel B" — the recruiter never hides the rest of the panel. */
export function formatInterviewers(m) {
  const rec = m.recruiter?.name || null;
  const panel = (Array.isArray(m.agents) ? m.agents : []).map((a) => a?.name).filter((n) => n && n !== rec);
  const out = [rec && `${rec} (recruiter)`, ...new Set(panel)].filter(Boolean);
  return out.length ? out.join(', ') : null;
}

export async function countInterviews(filters, user, deps) {
  return (await deps.queryMeetings(interviewMongoFilter(filters), { limit: 1 }, user))?.totalResults ?? 0;
}

// ─── Offers ─────────────────────────────────────────────────────────────────

export function offerQueryFilter(filters = {}) {
  return compact({
    search: filters.search,
    status: filters.status,
    stage: filters.stage,
    ...dayRange('created', filters.createdBetween),
  });
}

export async function countOffers(filters, user, deps) {
  return (await deps.queryOffers(offerQueryFilter(filters), { limit: 1 }, user))?.totalResults ?? 0;
}

export async function canSeeOfferCompensation(user) {
  return (await checkAccessRule(OFFER_COMPENSATION_RULE, user)).ok;
}

/** Offers-page list columns only; CTC only when showCtc. Never offerLetterUrl or rejectionReason. */
export function offerRow(o, { showCtc }) {
  const gross = o.ctcBreakdown?.gross;
  return {
    id: String(o.id ?? o._id ?? ''),
    offerCode: o.offerCode ?? null,
    candidate: o.candidate?.fullName ?? null,
    job: o.job?.title ?? null,
    position: o.positionTitle ?? null,
    status: o.status ?? null,
    placementStatus: o.placementStatus ?? null,
    joiningDate: o.joiningDate ?? null,
    createdAt: o.createdAt ?? null,
    sentAt: o.sentAt ?? null,
    acceptedAt: o.acceptedAt ?? null,
    ...(showCtc && gross ? { ctc: { gross, currency: o.ctcBreakdown?.currency || null } } : {}),
  };
}

// ─── Placements ─────────────────────────────────────────────────────────────

export function placementQueryFilter(filters = {}) {
  const status = filters.status || (filters.stage ? undefined : DEFAULT_PLACEMENT_STATUSES);
  return compact({
    search: filters.search,
    status,
    preBoardingStatus: filters.preBoardingStatus,
    stage: filters.stage,
    ...dayRange('joining', filters.joiningBetween),
  });
}

/** Statuses a breakdown can ask for: every status, or only the ones the stage queue narrows by. */
export function placementBreakdownStatuses(filters = {}, allStatuses) {
  return filters.stage ? STAGE_STATUSES[filters.stage] : allStatuses;
}

export async function countPlacements(filters, user, deps) {
  return (await deps.queryPlacements(placementQueryFilter(filters), { limit: 1 }, user))?.totalResults ?? 0;
}

export function placementRow(p) {
  return {
    id: String(p.id ?? p._id ?? ''),
    candidate: p.candidate?.fullName ?? null,
    employeeId: p.employeeId ?? p.candidate?.employeeId ?? null,
    job: p.job?.title ?? null,
    offerCode: p.offer?.offerCode ?? null,
    status: p.status ?? null,
    preBoardingStatus: p.preBoardingStatus ?? null,
    joiningDate: p.joiningDate ?? null,
    daysUntilJoining: p.daysUntilJoining ?? null,
    bgvStatus: p.backgroundVerification?.status ?? null,
  };
}

// ─── Referral leads ─────────────────────────────────────────────────────────

/**
 * { from, to } days → the Refer Leads page's from/to query keys, as ISO instants bounding whole IST days
 * (same validator and bounds as every other day window). The service takes a full instant in `to` as-is.
 */
export function referralWindow(window) {
  return compact(dayWindowBounds(window));
}

const SELF_WORDS = new Set(['me', 'myself', 'i', 'self', 'mine']);

/** "me", or the viewer's own name / email — resolved to the viewer without any user lookup. */
export function isSelfReference(value, viewer) {
  const v = String(value || '').trim().toLowerCase();
  return SELF_WORDS.has(v)
    || (!!viewer?.name && v === String(viewer.name).toLowerCase())
    || (!!viewer?.email && v === String(viewer.email).toLowerCase());
}

// Where each person filter lives on a referral lead (the Employee rows the Refer Leads page lists).
const LEAD_PERSON_FIELDS = Object.freeze({ referrer: 'referredByUserId', salesAgent: 'currentSalesAgentUserId' });

/**
 * One referrer / sales agent by name or email, searched ONLY among users who hold that role on some
 * referral lead — never the whole user directory (candidates.read is not users.read). An exact
 * name/email match wins; several partial matches come back as { matches } with names only, never emails.
 * ponytail: one distinct() over all referral leads per lookup; fine while leads stay in the tens of
 * thousands — past that, keep a referrer/agent id set on the service side instead.
 */
export async function resolveLeadPerson(role, name, viewer, deps) {
  const field = LEAD_PERSON_FIELDS[role];
  const leadMatch = { referredByUserId: { $exists: true, $ne: null } };
  if (field !== 'referredByUserId') leadMatch[field] = { $ne: null };
  const ids = await deps.Employee.distinct(field, leadMatch);
  if (!ids?.length) return { notFound: true };
  const q = String(name || '').trim();
  const safe = escapeRegex(q);
  const users = await deps.User.find({
    _id: { $in: ids },
    status: visibleUserStatusClause(),
    $or: [{ name: { $regex: safe, $options: 'i' } }, { email: { $regex: safe, $options: 'i' } }],
  }).select('_id name email status platformSuperUser').limit(10).lean();
  const visible = users.filter((u) => viewer?.platformSuperUser || canUserBeVisible(u));
  if (!visible.length) return { notFound: true };
  const lc = q.toLowerCase();
  const exact = visible.filter((u) => (u.name || '').toLowerCase() === lc || (u.email || '').toLowerCase() === lc);
  const one = exact.length === 1 ? exact[0] : (visible.length === 1 ? visible[0] : null);
  if (one) return { id: String(one._id), name: one.name };
  return { matches: visible.slice(0, 5).map((u) => ({ name: u.name })) };
}

export function referralLeadRow(r) {
  return {
    id: String(r.id ?? r._id ?? ''),
    candidate: r.fullName ?? null,
    email: r.email ?? null,
    referredBy: r.referredBy?.name ?? null,
    salesAgent: r.salesAgent?.name ?? null,
    job: r.job?.title ?? null,
    status: r.referralPipelineStatus ?? null,
    linkType: linkTypeLabel(r.referralContext),
    claimedAt: r.referredAt ?? null,
  };
}

export function hiringCountFacts(kind, label, total) {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}
