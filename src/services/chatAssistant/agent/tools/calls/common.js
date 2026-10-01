import Joi from 'joi';
import CallRecordModel, { STATUS_RANK, isTerminal } from '../../../../../models/callRecord.model.js';
import callRecordService from '../../../../callRecord.service.js';
import {
  resolveCallRecordingSources as realResolveCallRecordingSources,
  getArchivePresence as realGetArchivePresence,
} from '../../../../callRecordingArchive.service.js';
import { getUserByIdForRequester as realGetUserByIdForRequester } from '../../../../user.service.js';
import { userIsAdmin as realUserIsAdmin } from '../../../../../utils/roleHelpers.js';
import { UI_CALL_SOURCES } from '../../../../../utils/callSource.js';
import { readBolnaCallSummary } from '../../../../../utils/candidateExtraction.js';
import {
  authHasPermission,
  sanitizeCallRecord,
  sanitizeCallRecords,
} from '../../../../../utils/callRecordAccess.util.js';
import { dayWindowBounds } from '../employees/common.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { APPLICATIONS_PAGE_PERMISSION, followupDeps, runFollowups } from './followups.js';

// bolna.route.js GET /call-records and GET /call-records/:executionId: requirePermissions('calls.view').
export const CALLS_ACCESS = Object.freeze({ anyOf: ['calls.view'] });
export const MAX_LIST_LIMIT = 50;
export const CALL_STATUSES = [...Object.keys(STATUS_RANK), 'missed'];

const MAX_GROUPS = 31;
const MAX_TRANSCRIPT_CHARS = 6000;
const MAX_SUMMARY_CHARS = 1500;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

export const NOT_CAPTURED = Object.freeze({
  attemptNumber: 'not captured in DharwinOne (an application only records how many callbacks were booked)',
  hangupBy:
    'reported by the telephony provider on AI agent calls only; dialer calls do not record who hung up',
});

// Bolna telephony_data.hangup_by, stored as-is in telephonyData.
export const HANGUP_BY_MEANING = Object.freeze({
  Callee: 'the person called hung up',
  Caller: 'the calling side (AI agent / our number) ended the call',
  Plivo: 'the telephony provider ended the call',
  Carrier: 'the phone network ended the call',
  Error: 'the call ended on an error',
});

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.');
const objectId = Joi.string().pattern(/^[a-fA-F0-9]{24}$/);

const baseFilterKeys = {
  person: Joi.string().min(2).max(100)
    .description('Name or phone number of the person called, matched like the Call Records page search box. ' +
      'A 24-character candidate profile id matches that candidate\'s calls exactly. Never a pronoun.'),
  callType: Joi.string().valid(...UI_CALL_SOURCES)
    .description('ai_agent = Bolna AI verification calls; telephony = dialer (Twilio / Plivo) calls; in_app = in-app calls. ' +
      'Older calls have no call type and only count without this filter (see unclassifiedCalls).'),
  direction: Joi.string().valid('inbound', 'outbound')
    .description('Call direction. Calls whose provider did not report a direction are left out when this is set.'),
  provider: Joi.string().valid('twilio', 'plivo').description('Telephony provider that carried the call.'),
  calledBetween: Joi.object({ from: isoDay, to: isoDay })
    .description('Call date window (when the call was placed), inclusive whole days (IST).'),
  mine: Joi.boolean().description('true = only calls the signed-in user placed.'),
  placedBy: objectId.description('User id of the person who placed the calls, taken from a groupBy "caller" result. Use mine for the viewer.'),
};

export const callFilters = Joi.object({
  ...baseFilterKeys,
  status: Joi.string().valid(...CALL_STATUSES)
    .description('Call status. missed = no answer / cancelled; declined also covers busy. Omit for every status.'),
});

export const metricFilters = Joi.object(baseFilterKeys);

/** Fail closed without a user id: listCallRecords skips the non-admin scope entirely when userId is missing. */
export function callsScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('call tools need an authenticated user with an id');
  }
  return ctx.user;
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo or Bolna. */
export function callsDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    listCallRecords: deps.listCallRecords ?? callRecordService.listCallRecords,
    countCallRecords: deps.countCallRecords ?? callRecordService.countCallRecords,
    groupCallRecords: deps.groupCallRecords ?? callRecordService.groupCallRecords,
    summarizeCallRecords: deps.summarizeCallRecords ?? callRecordService.summarizeCallRecords,
    getCallRecordScopeFields: deps.getCallRecordScopeFields ?? callRecordService.getCallRecordScopeFields,
    userCanAccessCallRecord: deps.userCanAccessCallRecord ?? callRecordService.userCanAccessCallRecord,
    userIsAdmin: deps.userIsAdmin ?? realUserIsAdmin,
    resolveCallRecordingSources: deps.resolveCallRecordingSources ?? realResolveCallRecordingSources,
    getArchivePresence: deps.getArchivePresence ?? realGetArchivePresence,
    getUserByIdForRequester: deps.getUserByIdForRequester ?? realGetUserByIdForRequester,
    ...followupDeps(deps),
    CallRecord: deps.CallRecord ?? CallRecordModel,
  };
}

const userIdOf = (user) => String(user?.id ?? user?._id ?? '');

/** Same check the controller runs on req (authHasPermission reads req.user + req.authContext). */
export function viewerCan(user, permission) {
  return authHasPermission({ user, authContext: user?.authContext }, permission);
}

/** bolna.controller.js callRecordAccessFlags: the Call Transcripts / Call AI Features role toggles. */
export function fieldAccess(user) {
  return {
    canViewTranscripts: viewerCan(user, 'call-transcripts.read'),
    canViewAi: viewerCan(user, 'call-ai.read'),
  };
}

/** bolna.controller.js getCallRecords: ownership comes from the viewer, never from the filters. */
async function viewerOptions(user, deps) {
  return { userId: userIdOf(user), isAdmin: await deps.userIsAdmin(user) };
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function istDay(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : IST_DAY.format(d);
}

function directionOf(r) {
  const d = String(r?.telephonyData?.direction ?? r?.telephonyData?.call_type ?? '').toLowerCase();
  if (d === 'inbound' || d === 'incoming') return 'inbound';
  if (d === 'outbound' || d === 'outgoing') return 'outbound';
  return null;
}

function personOptions(person) {
  const q = String(person ?? '').trim();
  if (!q) return {};
  if (OBJECT_ID_RE.test(q)) return { candidateId: q };
  if (q.length < 2) throw new Error('person must be at least 2 characters.');
  return { search: q };
}

/** Filters → callRecord.service options. Every filter runs in Mongo, in the page's own scope. */
function serviceOptions(filters = {}, user) {
  const { from, to } = dayWindowBounds(filters.calledBetween);
  const opts = {
    ...personOptions(filters.person),
    status: filters.status,
    callSource: filters.callType,
    direction: filters.direction,
    provider: filters.provider,
    createdFrom: from,
    createdTo: to,
    createdBy: filters.mine ? userIdOf(user) : filters.placedBy,
    sortBy: 'createdAt',
    order: 'desc',
  };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  return opts;
}

/**
 * callType narrows to classified rows only; legacy rows have callSource null and the page shows
 * them only under "All". Report how many of those match everything else so the answer can say so.
 */
async function unclassifiedCount(opts, viewer, deps) {
  if (!opts.callSource) return {};
  const rest = { ...opts };
  delete rest.callSource;
  const n = await deps.countCallRecords({ ...rest, ...viewer, callSourceMissing: true });
  return n ? { unclassifiedCalls: n } : {};
}

function recordingAvailable(r) {
  const a = r.recordingArchive || {};
  return Boolean(r.recordingUrl || r.recordingArchivedAt || a.bolna?.key || a.plivo?.key || a.twilio?.key);
}

/** Row fields only; run sanitizeCallRecord first so AI fields follow the viewer's toggles. */
export function toCallRow(r) {
  return {
    id: r.executionId != null ? String(r.executionId) : null,
    when: r.createdAt ?? null,
    person: r.displayName ?? r.businessName ?? null,
    category: r.displayCategory ?? null,
    toNumber: r.toPhoneNumber || r.recipientPhoneNumber || r.phone || null,
    fromNumber: r.fromPhoneNumber || r.userNumber || null,
    callType: r.callSource ?? null,
    direction: directionOf(r),
    provider: r.telephonyData?.provider ?? null,
    durationSeconds: r.duration ?? null,
    status: r.status ?? null,
    hangupBy: r.telephonyData?.hangup_by ?? null,
    hangupReason: r.telephonyData?.hangup_reason ?? null,
    outcome: r.verification?.callOutcome ?? null,
    recordingAvailable: recordingAvailable(r),
  };
}

const hiddenFlags = (access) => ({
  ...(access.canViewAi ? {} : { aiFieldsHidden: true }),
  ...(access.canViewTranscripts ? {} : { transcriptHidden: true }),
});

async function labelGroups(groupBy, groups, user, deps) {
  if (groupBy === 'hangupBy') {
    return groups.map((g) => (g.value
      ? { ...g, meaning: HANGUP_BY_MEANING[g.value] ?? null }
      : { ...g, value: 'Not recorded' }));
  }
  if (groupBy !== 'caller') return groups.map((g) => ({ ...g, value: g.value ?? 'unknown' }));
  return Promise.all(groups.map(async (g) => {
    if (!g.value) return { value: 'No caller recorded', userId: null, count: g.count };
    try {
      const u = await deps.getUserByIdForRequester(g.value, user);
      return { value: u?.name || 'Unknown user', userId: g.value, count: g.count };
    } catch {
      return { value: 'Unknown user', userId: g.value, count: g.count };
    }
  }));
}

export async function runCallCount({ filters = {}, groupBy, user, deps }) {
  const opts = serviceOptions(filters, user);
  const viewer = await viewerOptions(user, deps);
  const unclassified = await unclassifiedCount(opts, viewer, deps);
  if (!groupBy) {
    const total = await deps.countCallRecords({ ...opts, ...viewer });
    return { total, filtersApplied: filters, ...unclassified };
  }
  const { total, groups } = await deps.groupCallRecords({ ...opts, ...viewer }, { groupBy, timezone: DEFAULT_TIMEZONE });
  const sorted = [...groups].sort(groupBy === 'day'
    ? (a, b) => String(b.value).localeCompare(String(a.value))
    : (a, b) => b.count - a.count);
  const shown = sorted.slice(0, MAX_GROUPS);
  const otherCount = sorted.slice(MAX_GROUPS).reduce((s, g) => s + g.count, 0);
  return {
    total,
    groupBy,
    groups: await labelGroups(groupBy, shown, user, deps),
    ...(otherCount ? { otherCount } : {}),
    filtersApplied: filters,
    ...unclassified,
  };
}

export async function runCallList({ filters = {}, limit = 20, user, deps }) {
  const opts = serviceOptions(filters, user);
  const viewer = await viewerOptions(user, deps);
  const access = fieldAccess(user);
  const lim = Math.min(limit, MAX_LIST_LIMIT);
  const [data, unclassified] = await Promise.all([
    deps.listCallRecords({ ...opts, ...viewer, page: 1, limit: lim }),
    unclassifiedCount(opts, viewer, deps),
  ]);
  return {
    total: data?.total ?? 0,
    records: sanitizeCallRecords(data?.results || [], access).map(toCallRow),
    ...(access.canViewAi ? {} : { aiFieldsHidden: true }),
    notCaptured: NOT_CAPTURED,
    filtersApplied: filters,
    ...unclassified,
  };
}

const INTEREST_TEXT = {
  interested: 'said they are still interested',
  not_interested: 'said they are not interested',
  withdrew: 'asked to withdraw their application',
};

const bound = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** AI-derived fields as attributed statements, never as fact. Salary etc. are not extracted. */
function aiInsights(record) {
  const day = istDay(record.completedAt || record.createdAt) || 'an unknown date';
  const who = record.candidate || /application/i.test(record.purpose || '') ? 'the candidate' : 'the person called';
  const v = record.verification || {};
  const summaryText = record.intelligence?.summary || readBolnaCallSummary(record.extractedData)?.subjective || null;
  const confirm = (value, what) => {
    if (value === true) return `On ${day} ${who} confirmed ${what}.`;
    if (value === false) return `On ${day} ${who} did not confirm ${what}.`;
    return null;
  };
  return {
    source: 'AI extraction from the call recording/transcript — attributed statements, not verified facts.',
    summary: summaryText ? `AI summary of the call on ${day}: "${bound(String(summaryText), MAX_SUMMARY_CHARS)}"` : null,
    interest: INTEREST_TEXT[v.stillInterested] ? `On ${day} ${who} ${INTEREST_TEXT[v.stillInterested]}.` : null,
    location: v.currentLocation ? `On ${day} ${who} said their current location is "${v.currentLocation}".` : null,
    availability: v.availability ? `On ${day} ${who} said their availability is "${v.availability}".` : null,
    nameConfirmation: v.correctedName
      ? `On ${day} ${who} gave their name as "${v.correctedName}".`
      : confirm(v.nameConfirmed, 'their name'),
    jobConfirmation: confirm(v.jobConfirmed, 'the job they applied for'),
    outcome: v.callOutcome ? `The AI agent classified the call outcome as "${v.callOutcome}".` : null,
    interviewSlot: v.interviewSlotOutcome
      ? `The AI agent recorded the interview-slot step as "${v.interviewSlotOutcome}".`
      : null,
    needsReview: record.callQuality?.status === 'needs_review' ? (record.callQuality.reasons || []) : null,
    salary: null,
    joiningDate: null,
    questions: null,
    concerns: null,
    otherOffers: null,
    notCaptured: [],
    takeaways: 'Salary, notice period, joining date, questions, concerns and other offers come from get_call_takeaways when a transcript exists.',
  };
}

/** Same availability rules and stream paths as bolna.controller.js getCallRecordingSources. */
async function recordingSources(executionId, deps) {
  try {
    const { bolnaUrl, plivo = [], twilioUrl } = await deps.resolveCallRecordingSources(executionId);
    const archived = await deps.getArchivePresence(executionId);
    const base = `/v1/bolna/call-records/${encodeURIComponent(executionId)}/recordings`;
    const src = (available, channel, kind) => (available
      ? { available: true, channel, streamUrl: `${base}/${kind}` }
      : { available: false });
    return {
      bolna: src(Boolean(bolnaUrl || archived?.bolna), 'agent_only', 'bolna'),
      plivo: src(Boolean(plivo.length || archived?.plivo), 'dual', 'plivo'),
      twilio: src(Boolean(twilioUrl || archived?.twilio), 'dual', 'twilio'),
    };
  } catch {
    return { error: 'Could not load the recording sources right now.' };
  }
}

/** One call by executionId, or the viewer's latest visible call with `person`. */
export async function runCallGet({ id, person, user, deps }) {
  const viewer = await viewerOptions(user, deps);
  let executionId = String(id ?? '').trim();
  let listRow = null;
  if (!executionId) {
    const data = await deps.listCallRecords({ ...serviceOptions({ person }, user), ...viewer, page: 1, limit: 1 });
    listRow = data?.results?.[0] ?? null;
    if (!listRow?.executionId) return { notFound: true, searchedFor: person };
    executionId = String(listRow.executionId);
  }

  // bolna.controller.js assertCanAccessCall, then the same single-record read getCallRecord does.
  const scope = await deps.getCallRecordScopeFields(executionId);
  if (!scope) return { notFound: true, id: executionId };
  if (!(await deps.userCanAccessCallRecord(scope, viewer))) {
    return { forbidden: true, error: 'You do not have access to this call.' };
  }
  const raw = await deps.CallRecord.findOne({ executionId }).lean();
  if (!raw) return { notFound: true, id: executionId };

  const access = fieldAccess(user);
  const record = sanitizeCallRecord(raw, access);
  const canHear = viewerCan(user, 'call-recording.view');
  const transcriptText = access.canViewTranscripts ? record.transcript || record.conversationTranscript || null : null;
  const call = { ...toCallRow(record), person: listRow?.displayName ?? record.businessName ?? null };
  return {
    call,
    ...(call.hangupBy ? { hangupMeaning: HANGUP_BY_MEANING[call.hangupBy] ?? null } : {}),
    aiInsights: access.canViewAi ? aiInsights(record) : null,
    transcript: transcriptText ? bound(String(transcriptText), MAX_TRANSCRIPT_CHARS) : null,
    ...(transcriptText && String(transcriptText).length > MAX_TRANSCRIPT_CHARS ? { transcriptTruncated: true } : {}),
    recordings: canHear ? await recordingSources(executionId, deps) : null,
    ...(canHear ? {} : { recordingsHidden: true }),
    ...hiddenFlags(access),
    notCaptured: NOT_CAPTURED,
  };
}

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/**
 * Applicant follow-up counts (Applications page scope). null + reason without that page's
 * permission. notYetCalled uses the call window as the application date window.
 */
async function applicantMetrics(filters, user, deps) {
  if (!viewerCan(user, APPLICATIONS_PAGE_PERMISSION)) {
    return {
      notYetCalledApplicants: null,
      callbacksDue: null,
      callbacksOverdue: null,
      applicantMetricsHidden: `needs the Applications page permission (${APPLICATIONS_PAGE_PERMISSION})`,
    };
  }
  const opts = { limit: 0 };
  const [notCalled, due, overdue] = await Promise.all([
    runFollowups('notYetCalled', { appliedBetween: filters.calledBetween }, user, deps, opts),
    runFollowups('callbackRequested', {}, user, deps, opts),
    runFollowups('callbackOverdue', {}, user, deps, opts),
  ]);
  return {
    notYetCalledApplicants: notCalled.total,
    callbacksDue: due.total,
    callbacksOverdue: overdue.total,
  };
}

/** Call metrics over the viewer's visible calls in a window, computed in Mongo. */
export async function runCallMetrics({ filters = {}, user, deps }) {
  const opts = serviceOptions(filters, user);
  const viewer = await viewerOptions(user, deps);
  const access = fieldAccess(user);
  const [summary, unclassified, applicants] = await Promise.all([
    deps.summarizeCallRecords({ ...opts, ...viewer }, { includeInterest: access.canViewAi }),
    unclassifiedCount(opts, viewer, deps),
    applicantMetrics(filters, user, deps),
  ]);

  const byStatus = summary.byStatus || {};
  const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const finished = Object.entries(byStatus).filter(([s]) => isTerminal(s)).reduce((s, [, n]) => s + n, 0);
  const answered = byStatus.completed || 0;
  let interestConfirmed = null;
  if (access.canViewAi) {
    const interest = summary.interest || {};
    const answeredQ = Object.values(interest).reduce((s, n) => s + n, 0);
    const interested = interest.interested || 0;
    interestConfirmed = { interested, answeredInterestQuestion: answeredQ, rate: rate(interested, answeredQ) };
  }

  return {
    totalCalls: total,
    byStatus,
    finishedCalls: finished,
    answeredCalls: answered,
    answerRate: rate(answered, finished),
    avgDurationSeconds: summary.avgCompletedDurationSeconds == null ? null : Math.round(summary.avgCompletedDurationSeconds),
    failedCalls: byStatus.failed || 0,
    interestConfirmed,
    ...(access.canViewAi ? {} : { aiFieldsHidden: true }),
    ...applicants,
    filtersApplied: filters,
    ...unclassified,
  };
}

export function callCountFacts(kind, total, label = 'calls') {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}
