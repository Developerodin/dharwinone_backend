/**
 * Shared helpers for the offer / placement detail tools (get_offer, get_placement, list_documents) and the
 * extra list/count filters (pendingOverDays, acceptedNoPreboarding, bgvPending, readyForBgv,
 * joinDatePassedNotOnboarded). Every row still comes from the page's own service with the viewer, so row
 * scope is the page's; the extra filters become extra service filter keys (Mongo), so totals are exact.
 */
import Joi from 'joi';
import config from '../../../../../config/config.js';
import { PLACEMENT_STATUSES } from '../../../../../constants/atsPipeline.js';
import RecruiterActivityLogModel from '../../../../../models/recruiterActivityLog.model.js';
import { userHasEmployeeRole as realUserHasEmployeeRole } from '../../../../../utils/roleHelpers.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { userCanViewPreBoardingDocs } from '../../../../../controllers/employee.controller.js';
import { getOfferById as realGetOfferById } from '../../../../offer.service.js';
import {
  getPlacementById as realGetPlacementById,
  listAuditForPlacementId as realListAuditForPlacementId,
  isPreboardingGateSatisfied,
} from '../../../../placement.service.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dayWindowBounds } from '../employees/common.js';
import { offerFilters, placementFilters } from './filters.js';
import { hiringDeps, offerQueryFilter, placementQueryFilter } from './common.js';

// employee.route.js canReadCandidateDocuments (GET /employees/documents/:candidateId and /documents/status/:id).
// The service then lets a viewer open someone else's documents only with userCanViewPreBoardingDocs.
export const DOCUMENTS_ACCESS = Object.freeze({
  anyOf: [
    'candidates.read', 'employees.read',
    'pre-boarding.read', 'pre-boarding.create', 'pre-boarding.edit', 'pre-boarding.delete', 'pre-boarding.manage',
  ],
});

// placement.route.js GET /placements/:placementId/audit.
export const PLACEMENT_AUDIT_ACCESS = Object.freeze({ anyOf: ['placement.audit', 'candidates.manage'] });

/**
 * list_documents cohort mode reads at most this many placement rows per call (scanTruncated says when the
 * queue had more). ponytail: fine while one queue stays in the hundreds; past that, page the cohort.
 */
export const SCAN_CAP = 500;

export const offerListFilters = offerFilters.keys({
  pendingOverDays: Joi.number().integer().min(1).max(365)
    .description('Only offers still Sent / Under Negotiation that were marked Sent more than this many days ago.'),
  acceptedNoPreboarding: Joi.boolean().valid(true)
    .description('Only accepted offers whose placement is Pending with pre-boarding not started.'),
});

export const placementListFilters = placementFilters.keys({
  bgvPending: Joi.boolean().valid(true)
    .description('Only placements whose background verification is Pending or In Progress. Without a status, ' +
      'only Pending / Onboarding placements.'),
  readyForBgv: Joi.boolean().valid(true)
    .description('Only placements whose BGV has not been requested yet and whose paperwork is complete: at ' +
      'least one document uploaded, none awaiting review or rejected, no open document requests.'),
  joinDatePassedNotOnboarded: Joi.boolean().valid(true)
    .description('Only placements whose joining date is before today and that are still Pending or Onboarding ' +
      '(never marked Joined, not deferred or cancelled).'),
  onboardingNotJoined: Joi.boolean().valid(true)
    .description('Status Onboarding whose joining date is today or later (IST): in onboarding and not joined yet. ' +
      'Not Cancelled, Deferred, Joined, or Onboarding rows whose joining date has already passed.'),
});

export const NOT_CAPTURED = 'not captured in DharwinOne';
const PENDING_OFFER_STATUSES = ['Sent', 'Under Negotiation'];
const ACTIVE_PLACEMENT_STATUSES = ['Pending', 'Onboarding'];
const STAGE_QUEUE_STATUSES = {
  preBoarding: ['Pending', 'Deferred', 'Cancelled'],
  onboarding: ['Onboarding', 'Joined', 'Deferred', 'Cancelled'],
};
const BGV_OPEN = 'Pending,In Progress';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTE_CHARS = 300;

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function detailDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    ...hiringDeps(ctx),
    getOfferById: deps.getOfferById ?? realGetOfferById,
    getPlacementById: deps.getPlacementById ?? realGetPlacementById,
    listAuditForPlacementId: deps.listAuditForPlacementId ?? realListAuditForPlacementId,
    RecruiterActivityLog: deps.RecruiterActivityLog ?? RecruiterActivityLogModel,
    userHasEmployeeRole: deps.userHasEmployeeRole ?? realUserHasEmployeeRole,
    now: deps.now ?? (() => new Date()),
  };
}

export const idOf = (v) => (v == null ? null : String(v._id ?? v.id ?? v));
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s) => (s ? String(s).slice(0, MAX_NOTE_CHARS) : null);
// Business-timezone calendar day of an instant. Also right for joiningDate, stored at UTC midnight on most
// rows and at IST midnight on a few: both land on the intended IST day (a UTC-prefix read does not).
const istDay = (d) => dateStrInTz(new Date(d), DEFAULT_TIMEZONE);
// EAD / visa dates are bare YYYY-MM-DD cast to UTC midnight (employee.model.js): read the ISO prefix.
const isoDay = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};
const dayDiff = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
const narrow = (requested, allowed) => (requested ? allowed.filter((s) => s === requested) : allowed);
/** First instant (ISO) of the IST day `daysAgo` days before now's IST day. */
const istDayStart = (now, daysAgo = 0) => dayWindowBounds({ from: addDaysToDateStr(istDay(now), -daysAgo) }).from;

/** A service 403/404 (ApiError) → a tool result; anything else is a real failure and rethrows. */
export function serviceMiss(err, what) {
  const code = err?.statusCode;
  if (code === 403) return { error: `You do not have access to this ${what}.` };
  if (code === 404) return { notFound: what };
  throw err;
}

// ─── Offers ─────────────────────────────────────────────────────────────────

/** Whole IST days since the offer was marked Sent, while it is still Sent / Under Negotiation; else null. */
export function offerDaysPending(o, now) {
  if (!PENDING_OFFER_STATUSES.includes(o?.status) || !o.sentAt) return null;
  return dayDiff(istDay(o.sentAt), istDay(now));
}

/**
 * queryOffers filter for the offer filters, and the statuses a count splits by (null = the page's own
 * breakdown); { empty } = the filters contradict each other.
 * daysPending > N ⇔ marked Sent before the first instant of the IST day N days ago (sentBefore).
 */
export function offerPlan(filters, now) {
  const { pendingOverDays, acceptedNoPreboarding } = filters;
  const query = offerQueryFilter(filters);
  if (!pendingOverDays && !acceptedNoPreboarding) return { query, statuses: null };
  if (pendingOverDays && acceptedNoPreboarding) return { empty: true };
  if (pendingOverDays) {
    const statuses = narrow(filters.status, PENDING_OFFER_STATUSES);
    if (!statuses.length) return { empty: true };
    const status = statuses.join(',');
    return {
      query: { ...query, status, sentBefore: istDayStart(now, pendingOverDays) },
      statuses,
      // Still-pending offers with no sentAt can never match; counted so the answer can say so.
      sentAtMissingQuery: { ...query, status, sentAtMissing: true },
    };
  }
  if ((filters.status && filters.status !== 'Accepted') || filters.stage === 'onboarding') return { empty: true };
  return {
    query: {
      ...query, status: 'Accepted', stage: 'preBoarding', placementStatus: 'Pending', placementPreBoardingStatus: 'Pending',
    },
    statuses: ['Accepted'],
  };
}

/** Exact count for one service filter (limit-1 page, the page's own totalResults). */
export const countOffersWith = async (query, user, deps) =>
  (await deps.queryOffers(query, { limit: 1 }, user))?.totalResults ?? 0;

// ─── Placements ─────────────────────────────────────────────────────────────

// Profile side of "paperwork complete", the Mongo form of documentCounts(emp): uploaded > 0 and no document
// pending review / rejected, no open document request. A document without a status counts as pending review
// (documentCounts reads status ?? 0).
export const PAPERWORK_COMPLETE_MATCH = Object.freeze({
  'documents.0': { $exists: true },
  documents: { $not: { $elemMatch: { status: { $in: [0, 2, null] } } } },
  documentRequests: { $not: { $elemMatch: { status: 'pending' } } },
});

/** queryPlacements filter for the placement filters, and the statuses a count splits by (null = page default). */
export function placementPlan(filters, now) {
  const query = placementQueryFilter(filters);
  const { bgvPending, readyForBgv, joinDatePassedNotOnboarded, onboardingNotJoined } = filters;
  if (onboardingNotJoined && (bgvPending || readyForBgv || joinDatePassedNotOnboarded)) return { empty: true };
  if (!bgvPending && !readyForBgv && !joinDatePassedNotOnboarded && !onboardingNotJoined) return { query, statuses: null };

  let statuses = onboardingNotJoined
    ? narrow(filters.status, ['Onboarding'])
    : joinDatePassedNotOnboarded
      ? narrow(filters.status, ACTIVE_PLACEMENT_STATUSES)
      : (filters.status ? [filters.status] : ACTIVE_PLACEMENT_STATUSES);
  // A stage queue narrows by one status only (placement.service applyStageFilter); the intersection is one.
  if (filters.stage) statuses = statuses.filter((s) => STAGE_QUEUE_STATUSES[filters.stage].includes(s));
  if (!statuses.length) return { empty: true };
  query.status = statuses.join(',');

  if (joinDatePassedNotOnboarded) {
    const cutoff = new Date(Date.parse(istDayStart(now)) - 1).toISOString();
    if (!query.joiningTo || query.joiningTo > cutoff) query.joiningTo = cutoff;
    if (query.joiningFrom && query.joiningFrom > query.joiningTo) return { empty: true };
  }
  if (onboardingNotJoined) {
    // Today or later. A passed joining day cannot match, with or without an account.
    const from = istDayStart(now);
    if (!query.joiningFrom || query.joiningFrom < from) query.joiningFrom = from;
    if (query.joiningTo && query.joiningFrom > query.joiningTo) return { empty: true };
  }
  if (readyForBgv) {
    // Ready for BGV implies BGV not started, so it wins over bgvPending.
    query.bgvStatus = 'Pending';
    query.bgvNotRequested = true;
    query.candidateMatch = PAPERWORK_COMPLETE_MATCH;
  } else if (bgvPending) {
    query.bgvStatus = BGV_OPEN;
  }
  return { query, statuses };
}

const bgvStatusOf = (p) => p.backgroundVerification?.status ?? 'Pending';

const sortTasks = (tasks) => [...(tasks || [])]
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map((t) => ({ title: t.title ?? null, required: t.required !== false, done: !!t.done, doneAt: t.doneAt ?? null }));

/** Pre-boarding → BGV → onboarding → joined, each with its status and dates as stored on the placement. */
export function placementSteps(p) {
  const bgv = p.backgroundVerification || {};
  const assets = Array.isArray(p.assetAllocation) ? p.assetAllocation : [];
  const it = Array.isArray(p.itAccess) ? p.itAccess : [];
  const om = p.orientationMeetingId && typeof p.orientationMeetingId === 'object' ? p.orientationMeetingId : null;
  let onboarding = 'Not started';
  if (p.onboardingCompletedAt) onboarding = 'Completed';
  else if (p.enteredOnboardingAt) onboarding = 'In progress';
  return [
    { step: 'Offer accepted', status: p.offer?.status ?? null, at: p.offer?.acceptedAt ?? null },
    { step: 'Pre-boarding', status: p.preBoardingStatus ?? null, tasks: sortTasks(p.preBoardingTasks) },
    {
      step: 'Background verification', status: bgv.status ?? null,
      requestedAt: bgv.requestedAt ?? null, completedAt: bgv.completedAt ?? null, agency: bgv.agency ?? null,
    },
    { step: 'Assets', status: assets.length ? 'Allocated' : 'None', items: assets.map((a) => a.name).filter(Boolean) },
    { step: 'IT access', status: it.length ? 'Provisioned' : 'None', items: it.map((a) => a.system).filter(Boolean) },
    {
      step: 'Onboarding', status: onboarding, startedAt: p.enteredOnboardingAt ?? null,
      completedAt: p.onboardingCompletedAt ?? null, tasks: sortTasks(p.onboardingTasks),
    },
    {
      step: 'Orientation meeting', status: om ? (om.status ?? 'scheduled') : 'None',
      at: om?.scheduledAt ?? null, title: om?.title ?? null,
    },
    { step: 'Joined', status: p.status === 'Joined' ? 'Joined' : 'Not yet', at: p.joinedAt ?? null },
  ];
}

/**
 * The first step holding this placement up, or null when nothing is. Pending → Onboarding uses the
 * service's own isPreboardingGateSatisfied (the gate updatePlacementStatus enforces).
 */
export function firstBlockingStep(p, now) {
  if (p.status === 'Cancelled' || p.status === 'Deferred') {
    const by = p.status === 'Cancelled' ? p.cancelledBy : p.deferredBy;
    return {
      step: p.status,
      detail: `Placement ${p.status.toLowerCase()}${by?.name ? ` by ${by.name}` : ''}.`,
      at: (p.status === 'Cancelled' ? p.cancelledAt : p.deferredAt) ?? null,
    };
  }
  if (p.status === 'Pending') {
    if (isPreboardingGateSatisfied(p)) {
      return { step: 'Move to Onboarding', detail: 'Pre-boarding is complete but the placement is still Pending.' };
    }
    const open = sortTasks(p.preBoardingTasks).find((t) => t.required && !t.done);
    if (open && config.ats?.preboardingChecklistEnabled !== false) {
      return { step: 'Pre-boarding', detail: `Required checklist step not done: ${open.title}.` };
    }
    const bgv = bgvStatusOf(p);
    if (bgv !== 'Completed' && bgv !== 'Verified') {
      return { step: 'Background verification', detail: `Background verification is ${bgv}.` };
    }
    return { step: 'Pre-boarding', detail: `Pre-boarding is ${p.preBoardingStatus ?? 'Pending'}.` };
  }
  const openOnboarding = sortTasks(p.onboardingTasks).find((t) => t.required && !t.done);
  if (openOnboarding) return { step: 'Onboarding', detail: `Required onboarding step not done: ${openOnboarding.title}.` };
  const joinDay = p.joiningDate ? istDay(p.joiningDate) : null;
  if (p.status === 'Onboarding' && joinDay && joinDay < istDay(now)) {
    return { step: 'Mark as Joined', detail: `Joining date ${joinDay} has passed; not marked Joined.` };
  }
  return null;
}

/** Joining calendar day is before today's IST day. Same day is not passed (IST-midnight rows included). */
export function joiningDateHasPassed(joiningDate, now) {
  if (!joiningDate) return false;
  const d = new Date(joiningDate);
  if (Number.isNaN(d.getTime())) return false;
  return istDay(d) < istDay(now);
}

/**
 * Which queue a placement status sits in. Pre-boarding's in-progress status is Pending
 * (PRE_BOARDING_QUEUE_STATUSES minus Deferred/Cancelled). Onboarding's is Onboarding.
 * Deferred and Cancelled are in the pre-boarding queue until enteredOnboardingAt is set,
 * then in the onboarding queue (placement.service applyStageFilter).
 */
export function placementQueue(status, enteredOnboardingAt) {
  if (status === 'Onboarding' || status === 'Joined') return 'onboarding';
  if (status === 'Pending') return 'preBoarding';
  return enteredOnboardingAt ? 'onboarding' : 'preBoarding';
}

const IN_PROGRESS = new Set(['Onboarding', 'Pending']);

/**
 * joined: status Joined, or still in progress (Onboarding or pre-boarding Pending) with the joining
 * day passed and a user account. Role is not read. Cancelled and Deferred are never joined.
 * notJoinedReason is null when joined.
 */
export function joinFacts({ status, enteredOnboardingAt, joiningDate, now, hasUserAccount }) {
  const joiningDatePassed = joiningDateHasPassed(joiningDate, now);
  const account = !!hasUserAccount;
  const queue = placementQueue(status, enteredOnboardingAt);
  const base = {
    joiningDate: joiningDate ?? null,
    joiningDatePassed,
    hasUserAccount: account,
    queue,
  };
  if (status === 'Joined') return { ...base, joined: true, notJoinedReason: null };
  if (status === 'Cancelled') return { ...base, joined: false, notJoinedReason: 'cancelled' };
  if (status === 'Deferred') return { ...base, joined: false, notJoinedReason: 'deferred' };
  if (IN_PROGRESS.has(status) && !joiningDatePassed) {
    return { ...base, joined: false, notJoinedReason: 'date_ahead' };
  }
  if (IN_PROGRESS.has(status) && joiningDatePassed && account) {
    return { ...base, joined: true, notJoinedReason: null };
  }
  if (IN_PROGRESS.has(status) && joiningDatePassed && !account) {
    return { ...base, joined: false, notJoinedReason: 'no_account' };
  }
  return { ...base, joined: false, notJoinedReason: null };
}

/** The candidate's login, if one exists. null = no user account. Role is not read. */
export async function loadLogin(email, deps) {
  if (!email) return null;
  const login = await deps.User.findOne({ email: String(email).toLowerCase() }).select('_id roleIds').lean();
  return login || null;
}

/** One placement the detail tool already loaded. */
export async function placementJoin(p, email, ctx) {
  const deps = detailDeps(ctx);
  const login = await loadLogin(email, deps);
  return {
    login,
    facts: joinFacts({
      status: p.status,
      enteredOnboardingAt: p.enteredOnboardingAt,
      joiningDate: p.joiningDate,
      now: deps.now(),
      hasUserAccount: !!login,
    }),
  };
}

async function emailsForRows(rawRows, deps) {
  const emailByIndex = new Map();
  const needProfile = [];
  rawRows.forEach((p, i) => {
    const onRow = p.candidate?.email;
    if (onRow) emailByIndex.set(i, String(onRow).toLowerCase());
    else if (idOf(p.candidate)) needProfile.push(i);
  });
  if (needProfile.length) {
    const ids = needProfile.map((i) => idOf(rawRows[i].candidate));
    const emps = await deps.Employee.find({ _id: { $in: ids } }).select('_id email').lean();
    const byId = new Map((emps || []).map((e) => [idOf(e), e.email ? String(e.email).toLowerCase() : null]));
    for (const i of needProfile) {
      const email = byId.get(idOf(rawRows[i].candidate));
      if (email) emailByIndex.set(i, email);
    }
  }
  return emailByIndex;
}

/**
 * joiningDatePassed / hasUserAccount / joined on each list row. One profile lookup and one user
 * lookup per page (limit 50). Past that, the page size is the ceiling — don't scan the directory.
 */
export async function listJoinFacts(rawRows, ctx) {
  const deps = detailDeps(ctx);
  const now = deps.now();
  if (!rawRows.length) return [];
  const emailByIndex = await emailsForRows(rawRows, deps);
  const uniqueEmails = [...new Set(emailByIndex.values())];
  const users = uniqueEmails.length
    ? await deps.User.find({ email: { $in: uniqueEmails } }).select('_id email').lean()
    : [];
  const have = new Set((users || []).filter((u) => u.email).map((u) => String(u.email).toLowerCase()));
  return rawRows.map((p, i) => joinFacts({
    status: p.status,
    enteredOnboardingAt: p.enteredOnboardingAt,
    joiningDate: p.joiningDate,
    now,
    hasUserAccount: have.has(emailByIndex.get(i)),
  }));
}

function placementEmail(p) {
  return p?.candidate?.email ? String(p.candidate.email).toLowerCase() : '';
}

/** Placement whose candidate email is this account. Other people's rows are not used. */
function ownPlacement(rows, email) {
  const wanted = email ? String(email).toLowerCase() : '';
  const mine = (rows || []).filter((p) => placementEmail(p) === wanted);
  return mine.find((p) => p.status !== 'Cancelled') || mine[0] || null;
}

/**
 * A user account Sage already opened. hasUserAccount is true. joiningDate comes from a placement
 * this viewer can see for that email (the placement list's own query). No placement → date not passed.
 * Ceiling: one placement page of 6. Role is not consulted.
 */
export async function joinFactsForKnownAccount({ email, viewer, ctx }) {
  const deps = detailDeps(ctx);
  let joiningDate = null;
  if (email) {
    const res = await deps.queryPlacements(
      { search: email, status: PLACEMENT_STATUSES.join(',') },
      { page: 1, limit: 6, sortBy: 'joiningDate:desc' },
      viewer,
    );
    const row = ownPlacement(res?.results, email);
    joiningDate = row?.joiningDate ?? null;
    return joinFacts({
      status: row?.status,
      enteredOnboardingAt: row?.enteredOnboardingAt,
      joiningDate,
      now: deps.now(),
      hasUserAccount: true,
    });
  }
  return joinFacts({ joiningDate, now: deps.now(), hasUserAccount: true });
}

// ─── Candidate documents ────────────────────────────────────────────────────

// Employee fields the document tools read — never urls/keys, salarySlips or salaryRange.
export const DOCUMENT_FIELDS = [
  'fullName', 'email', 'owner', 'employeeId', 'eadValidTo', 'visaExpiryDate',
  'documents.type', 'documents.label', 'documents.status', 'documents.adminNotes', 'documents.verifiedAt',
  'documents.verifiedBy', 'documents.logicalSlot', 'documents.slotVersion',
  'documentRequests.type', 'documentRequests.label', 'documentRequests.status',
  'documentRequests.requestedBy', 'documentRequests.requestedAt',
  'documentVersions.slot', 'documentVersions.version', 'documentVersions.createdBy',
].join(' ');

// employee.validation.js verifyDocument: 0 pending, 1 approved, 2 rejected.
const DOC_STATUS = Object.freeze({ 0: 'pending_review', 1: 'approved', 2: 'rejected' });
const docStatus = (d) => DOC_STATUS[d?.status ?? 0] ?? null;
const EXPIRY_FIELDS = [['eadValidTo', 'EAD card'], ['visaExpiryDate', 'Visa']];

/** Someone else's documents need the pre-boarding documents gate; one's own profile never does. */
export const canViewOthersDocuments = (user) =>
  !!user?.platformSuperUser || userCanViewPreBoardingDocs(user?.authContext?.permissions);

/** employee.service isOwnerOrAdmin, minus the manage flag (checked by canViewOthersDocuments). */
export const ownsProfile = (emp, user) =>
  idOf(emp.owner) === idOf(user)
  || (!!user?.email && String(emp.email || '').toLowerCase() === String(user.email).toLowerCase());

export async function loadDocumentProfiles(ids, deps) {
  if (!ids.length) return new Map();
  const rows = await deps.Employee.find({ _id: { $in: ids } }).select(DOCUMENT_FIELDS).lean();
  return new Map(rows.map((e) => [idOf(e), e]));
}

/**
 * One candidate / employee profile by name, email or employee id. An exact match wins; several → { matches }.
 * (attendance's resolvePerson returns the owner user, which for job-applied candidates is the recruiter.)
 */
export async function resolveProfile(person, deps) {
  const q = String(person || '').trim();
  if (!q) return { notFound: q };
  const exact = new RegExp(`^${escapeRegex(q)}$`, 'i');
  const rows = await deps.Employee.find({
    $or: [{ fullName: { $regex: escapeRegex(q), $options: 'i' } }, { email: exact }, { employeeId: exact }],
  }).select(DOCUMENT_FIELDS).limit(6).lean();
  if (!rows.length) return { notFound: q };
  const exactRows = rows.filter((r) => exact.test(r.fullName || '') || exact.test(r.email || '') || exact.test(r.employeeId || ''));
  if (exactRows.length === 1) return { profile: exactRows[0] };
  if (rows.length === 1) return { profile: rows[0] };
  return { matches: rows.map((r) => ({ name: r.fullName ?? null, employeeId: r.employeeId ?? null })) };
}

export function documentCounts(emp) {
  const docs = emp.documents || [];
  const by = (s) => docs.filter((d) => docStatus(d) === s).length;
  return {
    uploaded: docs.length,
    pendingReview: by('pending_review'),
    approved: by('approved'),
    rejected: by('rejected'),
    missing: (emp.documentRequests || []).filter((r) => r.status === 'pending').length,
  };
}

/** EAD / visa expiry from the profile (the only documents DharwinOne stores an expiry for). */
export function documentExpiries(emp, now, withinDays) {
  const today = istDay(now);
  return EXPIRY_FIELDS.filter(([f]) => emp[f]).map(([f, document]) => {
    const expiresOn = isoDay(emp[f]);
    const daysLeft = dayDiff(today, expiresOn);
    return {
      document, expiresOn, daysLeft, expired: daysLeft < 0,
      ...(withinDays ? { expiringSoon: daysLeft <= withinDays } : {}),
    };
  });
}

/** User ids a detail view names: reviewers, requesters, resume / cover-letter uploaders. */
export function documentActorIds(emp) {
  return [
    ...(emp.documents || []).map((d) => d.verifiedBy),
    ...(emp.documentRequests || []).map((r) => r.requestedBy),
    ...(emp.documentVersions || []).map((v) => v.createdBy),
  ].map(idOf).filter(Boolean);
}

/**
 * Full per-person document view. Uploader is only stored for resume / cover-letter versions
 * (documentVersions.createdBy); every other upload has no uploader on record → null.
 */
export function documentDetail(emp, { names, candidateUserId, now, withinDays }) {
  const nameOf = (id) => (id ? names.get(idOf(id)) ?? null : null);
  const uploaderBySlot = new Map((emp.documentVersions || []).map((v) => [`${v.slot}#${v.version}`, v.createdBy]));
  const documents = (emp.documents || []).map((d) => {
    const status = docStatus(d);
    const reviewed = status === 'approved' || status === 'rejected';
    const uploaderId = d.logicalSlot ? idOf(uploaderBySlot.get(`${d.logicalSlot}#${d.slotVersion}`)) : null;
    return {
      type: d.type ?? null,
      label: d.label ?? null,
      status,
      reviewedBy: reviewed ? nameOf(d.verifiedBy) : null,
      reviewedAt: reviewed ? d.verifiedAt ?? null : null,
      ...(status === 'rejected' ? { reason: clip(d.adminNotes) } : {}),
      uploadedBy: nameOf(uploaderId),
      uploadedByStaff: uploaderId && candidateUserId ? uploaderId !== candidateUserId : null,
    };
  });
  const requests = emp.documentRequests || [];
  return {
    candidateId: idOf(emp),
    name: emp.fullName ?? null,
    employeeId: emp.employeeId ?? null,
    counts: documentCounts(emp),
    documents,
    missing: requests.filter((r) => r.status === 'pending').map((r) => ({
      type: r.type ?? null, label: r.label ?? null, requestedBy: nameOf(r.requestedBy), requestedAt: r.requestedAt ?? null,
    })),
    expiries: documentExpiries(emp, now, withinDays),
  };
}

/** Compact cohort row: counts plus the labels that need action. */
export function documentSummary(emp, { now, withinDays }) {
  const docs = emp.documents || [];
  const labels = (s) => docs.filter((d) => docStatus(d) === s).map((d) => d.label || d.type).filter(Boolean);
  return {
    candidateId: idOf(emp),
    name: emp.fullName ?? null,
    employeeId: emp.employeeId ?? null,
    counts: documentCounts(emp),
    pendingReview: labels('pending_review'),
    rejected: labels('rejected'),
    missing: (emp.documentRequests || []).filter((r) => r.status === 'pending').map((r) => r.label || r.type),
    expiries: documentExpiries(emp, now, withinDays),
  };
}

export async function userNames(ids, deps) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await deps.User.find({ _id: { $in: unique } }).select('name').lean();
  return new Map(rows.map((u) => [idOf(u), u.name ?? null]));
}
