import { stageEntryDates, tallyBasis } from '../../../../applicationStatusHistory.js';
import { CLOSED_APPLICATION_STATUSES } from '../../../../../constants/atsPipeline.js';
import { INTERVIEWS_ACCESS, OFFERS_ACCESS, isSelfReference } from '../hiring/common.js';
import { APPLICATIONS_PAGE_PERMISSION } from '../calls/followups.js';
import {
  QUERY_MAX_MS, OBJECT_ID_RE, SECTION_TIMEOUT_MS, idOf, allowed, escapeRegex, visibilityToMongo, cappedRows,
  istBounds, todayIst, addDaysToDateStr,
} from './common.js';
import { runWithTimeout, TOOL_TIMEOUT } from '../../runWithTimeout.js';

/*
 * Recruitment funnel for the cohort of applications CREATED in a window (Applications-page scope,
 * buildApplicantQuery, one row per job + applicant like the page's dedupe).
 *
 * Stage entry dates come from applicationStatusHistory.stageEntryDates: the application's statusHistory
 * when it has one (basis 'history'), else derived dates (basis 'derived'): first non-cancelled interview
 * created → Interview, first offer created → Offered, offer accepted → Hired (= accepted; offer.service sets
 * Hired on acceptance). Screening has no derived record, so it is only measured on history-basis rows.
 * Onboarding and hired (joined) are placement facts, not application statuses: they always come from the
 * placement (enteredOnboardingAt, joinedAt), whatever the application's basis.
 *
 * ponytail: one capped cohort read (SET_CAP applications) plus three $in reads (meetings, offers,
 * placements). Past a few thousand applications per window, move stage dating into an aggregate.
 */

export const STAGES = [
  { key: 'application', status: 'Applied' },
  { key: 'screening', status: 'Screening' },
  { key: 'interview', status: 'Interview' },
  { key: 'offer', status: 'Offered' },
  { key: 'accepted', status: 'Hired' },
  { key: 'onboarding' },
  { key: 'hired' },
];
const IDX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const STATUS_LEVEL = { Applied: 0, Screening: 1, Shortlisted: 1, Interview: 2, Offered: 3, Hired: 4, Rejected: 0 };
const OPEN_OFFER_STATUSES = ['Draft', 'Sent', 'Under Negotiation'];
const DAY_MS = 86400000;
const round1 = (n) => Math.round(n * 10) / 10;
const avg = (xs) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const days = (from, to) => (to - from) / DAY_MS;
const uniq = (xs) => [...new Set(xs.filter(Boolean).map(String))];
const isEmptyScope = (q) => Array.isArray(q?._id?.$in) && q._id.$in.length === 0;

async function section(name, fn) {
  try {
    return { status: 'ok', ...(await runWithTimeout(fn, SECTION_TIMEOUT_MS)) };
  } catch (err) {
    if (err?.code === TOOL_TIMEOUT) return { status: 'timeout', section: name };
    return { status: 'error', section: name, error: err?.message || String(err) };
  }
}

// ─── Windows ────────────────────────────────────────────────────────────────

const lastDayOfMonth = (day) => addDaysToDateStr(`${addDaysToDateStr(`${day.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);

/** Previous calendar month for a whole-month window, else the equal-length period just before. */
export function previousWindow({ from, to }) {
  if (from.endsWith('-01') && to === lastDayOfMonth(from)) {
    const prevTo = addDaysToDateStr(from, -1);
    return { from: `${prevTo.slice(0, 7)}-01`, to: prevTo };
  }
  const len = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  const prevTo = addDaysToDateStr(from, -1);
  return { from: addDaysToDateStr(prevTo, 1 - len), to: prevTo };
}

export function defaultWindow(now) {
  const to = todayIst(now);
  return { from: addDaysToDateStr(to, -29), to };
}

// ─── Scope: recruiter → jobs ────────────────────────────────────────────────

/**
 * A recruiter by name, searched only among users who own (assignedRecruiter, else creator) a job the viewer
 * can see — never the whole user directory. Returns { id, name, jobIds } | { notFound } | { matches }.
 */
export async function resolveRecruiter(name, { user, deps }) {
  const vis = await deps.resolveJobVisibilityFilter(user);
  let rec;
  if (isSelfReference(name, user)) rec = { id: String(user.id ?? user._id), name: user.name ?? null };
  else {
    const [assigned, creators] = await Promise.all([
      deps.Job.distinct('assignedRecruiter', { $and: [vis, { assignedRecruiter: { $ne: null } }] }),
      deps.Job.distinct('createdBy', vis),
    ]);
    const ids = uniq([...assigned, ...creators].map(idOf));
    if (!ids.length) return { notFound: true };
    const q = String(name).trim();
    const users = await deps.User.find({ _id: { $in: ids }, name: { $regex: escapeRegex(q), $options: 'i' } })
      .select('name').limit(10).lean();
    const exact = users.filter((u) => String(u.name || '').toLowerCase() === q.toLowerCase());
    const pick = exact.length === 1 ? exact[0] : (users.length === 1 ? users[0] : null);
    if (!users.length) return { notFound: true };
    if (!pick) return { matches: users.slice(0, 5).map((u) => ({ name: u.name })) };
    rec = { id: idOf(pick), name: pick.name ?? null };
  }
  const jobs = await deps.Job.find({
    $and: [vis, { $or: [{ assignedRecruiter: rec.id }, { assignedRecruiter: null, createdBy: rec.id }] }],
  }).select('_id').maxTimeMS(QUERY_MAX_MS).lean();
  return { ...rec, jobIds: jobs.map(idOf) };
}

// ─── Cohort ─────────────────────────────────────────────────────────────────

async function loadCohort({ user, deps }, window, jobIds) {
  const { from, to } = istBounds(window.from, window.to);
  const filter = { excludeInternal: true, dateFrom: from.toISOString(), dateTo: to.toISOString(), ...(jobIds ? { jobIds } : {}) };
  const { query } = await deps.buildApplicantQuery(filter, user);
  if (isEmptyScope(query)) return { apps: [], truncated: false };
  const { rows, truncated } = await cappedRows(deps.JobApplication.find(query)
    .select('job candidate applicantUser status createdAt updatedAt statusChangedAt statusHistory')
    .sort({ createdAt: -1, _id: -1 }));
  const seen = new Set();
  const apps = rows.filter((a) => {
    const k = `${idOf(a.job)}|${idOf(a.applicantUser ?? a.candidate)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const appIds = apps.map(idOf);
  if (!appIds.length) return { apps, truncated };
  const [meetings, offers] = await Promise.all([
    deps.Meeting.find({ applicationId: { $in: appIds }, status: { $ne: 'cancelled' } })
      .select('applicationId createdAt').maxTimeMS(QUERY_MAX_MS).lean(),
    deps.Offer.find({ jobApplication: { $in: appIds } })
      .select('jobApplication status createdAt acceptedAt').maxTimeMS(QUERY_MAX_MS).lean(),
  ]);
  const accepted = offers.filter((o) => o.status === 'Accepted');
  const placements = accepted.length
    ? await deps.Placement.find({ offer: { $in: accepted.map(idOf) } })
      .select('offer status enteredOnboardingAt joinedAt').maxTimeMS(QUERY_MAX_MS).lean()
    : [];
  const firstMeeting = new Map();
  for (const m of meetings) {
    const k = idOf(m.applicationId);
    if (!firstMeeting.has(k) || m.createdAt < firstMeeting.get(k)) firstMeeting.set(k, m.createdAt);
  }
  const offersByApp = new Map();
  for (const o of offers) offersByApp.set(idOf(o.jobApplication), [...(offersByApp.get(idOf(o.jobApplication)) || []), o]);
  const placementByOffer = new Map(placements.map((p) => [idOf(p.offer), p]));
  for (const a of apps) {
    const id = idOf(a);
    const os = offersByApp.get(id) || [];
    const acc = os.find((o) => o.status === 'Accepted') || null;
    a._firstInterviewAt = firstMeeting.get(id) ?? null;
    a._firstOfferAt = os.length ? os.reduce((m, o) => (o.createdAt < m ? o.createdAt : m), os[0].createdAt) : null;
    a._offer = acc || os[0] || null;
    a._placement = acc ? placementByOffer.get(idOf(acc)) ?? null : null;
  }
  return { apps, truncated };
}

/** One application → { entry (stageEntryDates), dates by stage key, level (deepest stage reached), open }. */
export function dateApplication(app) {
  const entry = stageEntryDates(app, {
    Interview: app._firstInterviewAt ?? undefined,
    Offered: app._firstOfferAt ?? undefined,
    Hired: app._offer?.status === 'Accepted' ? app._offer.acceptedAt ?? undefined : undefined,
  });
  const p = app._placement;
  const toDate = (d) => (d ? new Date(d) : null);
  const dates = {
    application: toDate(entry.stages?.Applied ?? app.createdAt),
    screening: entry.basis === 'history' ? toDate(entry.stages?.Screening) : null,
    interview: toDate(entry.stages?.Interview),
    offer: toDate(entry.stages?.Offered),
    accepted: toDate(entry.stages?.Hired),
    onboarding: toDate(p?.enteredOnboardingAt),
    hired: toDate(p?.joinedAt),
  };
  let level = STATUS_LEVEL[app.status] ?? 0;
  for (const s of STAGES) if (dates[s.key]) level = Math.max(level, IDX[s.key]);
  if (app._firstInterviewAt) level = Math.max(level, IDX.interview);
  if (app._offer) level = Math.max(level, app._offer.status === 'Accepted' ? IDX.accepted : IDX.offer);
  if (p && (p.enteredOnboardingAt || ['Onboarding', 'Joined'].includes(p.status))) level = Math.max(level, IDX.onboarding);
  if (p?.status === 'Joined') level = IDX.hired;
  const closedPlacement = p && ['Joined', 'Cancelled', 'Deferred'].includes(p.status);
  const open = app.status !== 'Rejected' && level < IDX.hired && !closedPlacement && app._offer?.status !== 'Rejected';
  return { entry, dates, level, open };
}

const TRANSITIONS = [
  ['application', 'interview'], ['interview', 'offer'], ['offer', 'accepted'], ['accepted', 'onboarding'], ['onboarding', 'hired'],
];
const SCREENING_TRANSITIONS = [['application', 'screening'], ['screening', 'interview']];
const CONVERSIONS = [
  ['application', 'interview', 'all'], ['application', 'screening', 'history'], ['screening', 'interview', 'history'],
  ['interview', 'offer', 'all'], ['offer', 'accepted', 'all'], ['accepted', 'onboarding', 'all'], ['onboarding', 'hired', 'all'],
];

export function computeFunnel(apps, now) {
  const dated = apps.map((a) => dateApplication(a));
  const basis = tallyBasis(dated.map((d) => d.entry));
  const hist = dated.filter((d) => d.entry.basis === 'history');
  const reached = (key, pop = dated) => pop.filter((d) => d.level >= IDX[key]).length;

  const stages = STAGES.map((s) => ({
    stage: s.key,
    ...(s.key === 'screening'
      ? { reached: reached('screening', hist), population: 'history', notCaptured: dated.length - hist.length }
      : { reached: reached(s.key) }),
  }));

  const conversions = CONVERSIONS.map(([from, to, pop]) => {
    const p = pop === 'history' ? hist : dated;
    const denominator = reached(from, p);
    const numerator = reached(to, p);
    return {
      from, to, numerator, denominator,
      rate: denominator ? round1((numerator / denominator) * 100) : null,
      ...(pop === 'history' ? { population: 'history' } : {}),
    };
  });

  const nowMs = new Date(now).getTime();
  const stageAging = STAGES.slice(0, IDX.hired).map((s) => {
    const here = dated.filter((d) => d.open && d.level === IDX[s.key]);
    const ages = here.map((d) => d.dates[s.key]).filter(Boolean).map((d) => round1(days(d.getTime(), nowMs)));
    return { stage: s.key, open: here.length, avgDays: avg(ages), maxDays: ages.length ? Math.max(...ages) : null, withoutDate: here.length - ages.length };
  }).filter((r) => r.open > 0);

  const transition = ([from, to]) => {
    const spans = dated.filter((d) => d.dates[from] && d.dates[to] && d.dates[to] >= d.dates[from])
      .map((d) => days(d.dates[from].getTime(), d.dates[to].getTime()));
    return { from, to, n: spans.length, avgDays: avg(spans), medianDays: median(spans) };
  };
  const transitions = TRANSITIONS.map(transition);
  const screeningTransitions = SCREENING_TRANSITIONS.map(transition);
  const slowest = transitions.filter((t) => t.n > 0).reduce((m, t) => (!m || t.avgDays > m.avgDays ? t : m), null);

  const cycles = dated.filter((d) => d.dates.onboarding && d.dates.application)
    .map((d) => days(d.dates.application.getTime(), d.dates.onboarding.getTime())).filter((x) => x >= 0);

  return {
    applications: dated.length,
    basis,
    stages,
    conversions,
    stageAging,
    transitions,
    screeningTransitions,
    slowestStage: slowest,
    cycleTime: { applicationToOnboarding: { n: cycles.length, avgDays: avg(cycles), medianDays: median(cycles) } },
  };
}

// ─── Recruiter pending workload ─────────────────────────────────────────────

/**
 * Open applications (aggregateApplicationsByJob, not Offered / Hired / Rejected), open interviews (not
 * cancelled, result still pending; meetingScope) and open offers (Draft / Sent / Under Negotiation; offer
 * visibility), per recruiter = the job's assignedRecruiter, else the job creator. A workload comparison only.
 */
async function recruiterWorkload({ user, deps }, jobIds, limit) {
  const jobFilter = jobIds ? { jobIds } : {};
  const [byJob, canIv, canOffers] = await Promise.all([
    deps.aggregateApplicationsByJob({ excludeInternal: true, ...jobFilter }, user),
    allowed(INTERVIEWS_ACCESS, user, deps),
    allowed(OFFERS_ACCESS, user, deps),
  ]);
  const jobClause = (field) => (jobIds ? { [field]: { $in: jobIds } } : {});
  const [ivRows, offerRows] = await Promise.all([
    canIv ? deps.meetingScope(user, 'read').then(({ filter }) => cappedRows(deps.Meeting.find({
      $and: [filter, { status: { $ne: 'cancelled' } }, { $or: [{ interviewResult: 'pending' }, { interviewResult: null }] }, jobClause('jobId')],
    }).select('jobId recruiter.id'))) : null,
    canOffers ? deps.buildOfferVisibilityClause(user).then((c) => {
      const vis = visibilityToMongo(c);
      return vis === null ? { rows: [], truncated: false }
        : cappedRows(deps.Offer.find({ $and: [vis, { status: { $in: OPEN_OFFER_STATUSES } }, jobClause('job')] }).select('job'));
    }) : null,
  ]);
  const jobIdsSeen = uniq([
    ...byJob.map((r) => r.jobId), ...(ivRows?.rows || []).map((m) => idOf(m.jobId)), ...(offerRows?.rows || []).map((o) => idOf(o.job)),
  ]).filter((id) => OBJECT_ID_RE.test(id));
  const jobs = jobIdsSeen.length
    ? await deps.Job.find({ _id: { $in: jobIdsSeen } }).select('assignedRecruiter createdBy').maxTimeMS(QUERY_MAX_MS).lean()
    : [];
  const recruiterOf = new Map(jobs.map((j) => [idOf(j), idOf(j.assignedRecruiter ?? j.createdBy)]));
  const tally = new Map();
  const bump = (rid, field, n = 1) => {
    if (!rid) return;
    const cur = tally.get(rid) || { openApplications: 0, openInterviews: canIv ? 0 : null, openOffers: canOffers ? 0 : null };
    cur[field] += n;
    tally.set(rid, cur);
  };
  for (const r of byJob) {
    const open = Object.entries(r.byStage || {}).filter(([s]) => !CLOSED_APPLICATION_STATUSES.includes(s)).reduce((a, [, n]) => a + n, 0);
    if (open) bump(recruiterOf.get(r.jobId), 'openApplications', open);
  }
  for (const m of ivRows?.rows || []) bump(recruiterOf.get(idOf(m.jobId)) ?? (m.recruiter?.id ? String(m.recruiter.id) : null), 'openInterviews');
  for (const o of offerRows?.rows || []) bump(recruiterOf.get(idOf(o.job)), 'openOffers');
  const ids = [...tally.keys()].filter((id) => OBJECT_ID_RE.test(id));
  const users = ids.length ? await deps.User.find({ _id: { $in: ids } }).select('name').lean() : [];
  const nameOf = new Map(users.map((u) => [idOf(u), u.name ?? null]));
  const rows = [...tally.entries()].map(([id, t]) => ({
    recruiter: nameOf.get(id) ?? null, ...t, total: t.openApplications + (t.openInterviews ?? 0) + (t.openOffers ?? 0),
  })).sort((a, b) => b.total - a.total || String(a.recruiter).localeCompare(String(b.recruiter)));
  return {
    total: rows.length,
    medianTotal: median(rows.map((r) => r.total)),
    rows: rows.slice(0, limit),
    sections: { interviews: canIv ? 'ok' : 'restricted', offers: canOffers ? 'ok' : 'restricted' },
    ...(ivRows?.truncated || offerRows?.truncated ? { atLeast: true } : {}),
    note: 'Pending workload (open items per recruiter) — a workload comparison, not a measure of recruiter quality.',
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runFunnel(args, e) {
  const { user, deps } = e;
  const window = args.window ?? defaultWindow(deps.now());
  if (window.from > window.to) return { error: `Invalid window: from is after to (${window.from} > ${window.to}).` };
  if (!(await allowed({ anyOf: [APPLICATIONS_PAGE_PERMISSION] }, user, deps))) {
    return { status: 'restricted', section: 'Applications', note: 'You do not have access to: Applications.' };
  }

  let jobIds = args.jobId ? [args.jobId] : null;
  let recruiter = null;
  if (args.recruiter) {
    const r = await resolveRecruiter(args.recruiter, e);
    if (r.notFound) return { notFound: 'recruiter', searchedFor: args.recruiter };
    if (r.matches) return { ambiguous: 'recruiter', matches: r.matches };
    recruiter = r.name;
    jobIds = jobIds ? jobIds.filter((id) => r.jobIds.includes(id)) : r.jobIds;
  }
  const emptyJobs = Array.isArray(jobIds) && jobIds.length === 0;
  const limit = args.limit ?? 10;
  const prev = args.compareTo === 'previous' ? previousWindow(window) : null;

  const cohortFor = (w) => section('Cohort', async () => {
    if (emptyJobs) return { cohort: { applications: 0, truncated: false }, ...computeFunnel([], deps.now()) };
    const { apps, truncated } = await loadCohort(e, w, jobIds);
    return { cohort: { applications: apps.length, truncated, ...(truncated ? { atLeast: true } : {}) }, ...computeFunnel(apps, deps.now()) };
  });
  const [current, previous, workload] = await Promise.all([
    cohortFor(window),
    prev ? cohortFor(prev) : null,
    section('Recruiter workload', () => (emptyJobs ? { total: 0, rows: [] } : recruiterWorkload(e, jobIds, limit))),
  ]);

  const notes = [
    'Reached = entered the stage or any later one. Screening is only dated in status history, so its counts use ' +
      'history-basis applications only (notCaptured = the rest).',
    'Onboarding and hired dates always come from the placement record (entered onboarding, joined).',
  ];
  if (current.status === 'ok' && current.basis?.approximate) {
    notes.push(`${current.basis.approximate} application(s) have backfilled history marked approximate; their dates are approximate.`);
  }
  if (emptyJobs) notes.push('No jobs match that recruiter / job, so the cohort is empty.');

  const out = {
    window,
    ...(args.jobId ? { jobId: args.jobId } : {}),
    ...(recruiter ? { recruiter } : {}),
    funnel: current,
    recruiterWorkload: workload,
    notes,
  };
  if (previous) {
    out.previous = previous.status === 'ok' ? {
      window: prev,
      status: 'ok',
      cohort: previous.cohort,
      basis: previous.basis,
      stages: previous.stages,
      conversions: previous.conversions,
      slowestStage: previous.slowestStage,
    } : { window: prev, status: previous.status };
    if (current.status === 'ok' && previous.status === 'ok') {
      out.change = current.conversions.map((c, i) => ({
        from: c.from, to: c.to, rate: c.rate, previousRate: previous.conversions[i].rate,
        delta: c.rate != null && previous.conversions[i].rate != null ? round1(c.rate - previous.conversions[i].rate) : null,
      }));
    }
  }
  return out;
}
