import Joi from 'joi';
import { getMeetingById as realGetMeetingById, resolveJobPositionDisplayTitle } from '../../../../meeting.service.js';
import recordingService from '../../../../recording.service.js';
import {
  getInterviewSummary as realGetInterviewSummary,
  getInterviewTranscript as realGetInterviewTranscript,
} from '../../../../interviewTranscript.service.js';
import { listEvaluationsForMeetings as realListEvaluations } from '../../../../interviewEvaluation.service.js';
import { writeDedupedInterviewViewAudit } from '../../../../../utils/interviewViewAuditDedup.js';
import { buildMeetingsMongoFilter } from '../../../../../utils/meetingQueryFilter.js';
import { ActivityActions, EntityTypes } from '../../../../../config/activityLog.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { interviewFilters } from './filters.js';
import { hiringDeps, interviewMongoFilter } from './common.js';
import { dayWindowBounds } from '../employees/common.js';
import { auditDeps, passesGate, activityTier } from '../audit/common.js';

// meeting.route.js GET /:id/transcript (interviewTranscript.controller getTranscript): this permission, then
// getInterviewTranscript -> getMeetingById (meetingScope) — an interview outside the viewer's scope is a 404.
export const INTERVIEW_TRANSCRIPT_ACCESS = Object.freeze({
  anyOf: ['interviews.transcript.read'],
  note: 'rows scoped by meetingScope in getInterviewTranscript; a candidate-name lookup also needs interviews.read',
});
// meeting.route.js GET /:id/summary
const INTERVIEW_SUMMARY_RULE = Object.freeze({ anyOf: ['interviews.summary.read'] });
// meeting.route.js GET / — needed to look an interview up by candidate name.
const INTERVIEW_LOOKUP_RULE = Object.freeze({ anyOf: ['interviews.read'] });

// ponytail: overlap detection loads the whole window into memory and pairs rows in JS. Past this many
// interviews in one window the tool refuses and asks for a narrower window; an aggregation on the
// service side is the upgrade if a real window ever needs more.
export const OVERLAP_SCAN_LIMIT = 300;
const MAX_MATCHES = 10;
const MAX_CONFLICTS_PER_ROW = 5;
const MAX_SUMMARY_CHARS = 1500;
const MAX_COMMENT_CHARS = 500;
const MAX_TRANSCRIPT_WINDOWS = 12;
const MAX_EXCERPT_CHARS = 280;
// The registry's size cap only shrinks top-level arrays, so the full-text string is bounded here.
export const MAX_FULL_TEXT_CHARS = 12000;
const DEFAULT_DURATION_MIN = 60;
// meeting.validation.js caps durationMinutes at 480; the overlap scan starts this much before the window
// so an interview that starts earlier and runs into it is still compared.
export const MAX_DURATION_MIN = 480;
const MAX_ATTENDEES = 20;
const MAX_HISTORY = 20;
// ActivityLog actions the Interviews controller writes that answer "who set the result" / "were invites re-sent".
const HISTORY_ACTIONS = Object.freeze({
  [ActivityActions.INTERVIEW_RESULT_UPDATE]: 'result changed',
  [ActivityActions.INTERVIEW_INVITATION_RESEND]: 'invitations re-sent',
});

// Checked against the models 2026-09-30. Result changes and invitation re-sends ARE logged (ActivityLog,
// returned as `history`); who joined the video room is Meeting.participantRoster (returned as `attendance`).
export const NOT_CAPTURED = Object.freeze([
  'RSVP (candidates never accept / decline an invite in DharwinOne)',
  'invitation email delivery (not shown anywhere in the app)',
  'reschedule history (edits are logged, but not the old slot)',
]);

const ENDED_CLAUSE = buildMeetingsMongoFilter({ status: 'ended' }).$and[0];
const NOT_CANCELLED_CLAUSE = { status: { $not: /^cancelled$/i } };

export const interviewDetailFilters = interviewFilters.keys({
  resultMissing: Joi.boolean().valid(true)
    .description('true = ended interviews whose result is still pending (nobody recorded selected / rejected).'),
  overlapping: Joi.boolean().valid(true)
    .description('true = interviews where a panel member (recruiter or panel interviewer) has another non-cancelled ' +
      'interview at an overlapping time, among interviews you can see. Needs scheduledBetween.'),
});

/** hiringDeps plus the interview-detail services; ctx.deps overrides for tests. */
export function interviewDetailDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    ...hiringDeps(ctx),
    ...auditDeps(ctx),
    getMeetingById: deps.getMeetingById ?? realGetMeetingById,
    listRecordings: deps.listRecordings ?? recordingService.listByMeetingId,
    getInterviewTranscript: deps.getInterviewTranscript ?? realGetInterviewTranscript,
    getInterviewSummary: deps.getInterviewSummary ?? realGetInterviewSummary,
    listEvaluations: deps.listEvaluations ?? realListEvaluations,
    resolveJobTitle: deps.resolveJobTitle ?? resolveJobPositionDisplayTitle,
    writeViewAudit: deps.writeViewAudit ?? writeDedupedInterviewViewAudit,
    checkAccess: deps.checkAccess ?? checkAccessRule,
  };
}

export const idOf = (m) => String(m?.id ?? m?._id ?? '');
export const isNotFound = (err) => err?.statusCode === 404;
const bound = (text, max) => {
  if (typeof text !== 'string' || !text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function endsAt(m) {
  const start = new Date(m.scheduledAt).getTime();
  if (Number.isNaN(start)) return null;
  const mins = Number(m.durationMinutes) > 0 ? Number(m.durationMinutes) : DEFAULT_DURATION_MIN;
  return new Date(start + mins * 60000);
}

// ─── Filter extensions ──────────────────────────────────────────────────────

/**
 * Everyone on a panel (recruiter + panel interviewers) as { name, keys }: two entries are one person when they
 * share an id or an email (a recruiter who is also an agent counts once). Name is the key only when an entry
 * has neither, since two people can share a name.
 */
function panelMembers(m) {
  const members = [];
  for (const p of [m.recruiter, ...(Array.isArray(m.agents) ? m.agents : [])]) {
    if (!p) continue;
    const keys = new Set();
    if (p.id) keys.add(`i:${p.id}`);
    if (p.email) keys.add(`e:${String(p.email).trim().toLowerCase()}`);
    if (!keys.size && p.name) keys.add(`n:${String(p.name).trim().toLowerCase()}`);
    if (!keys.size) continue;
    const same = members.find((x) => [...keys].some((k) => x.keys.has(k)));
    if (same) keys.forEach((k) => same.keys.add(k));
    else members.push({ name: p.name || p.email || null, keys });
  }
  return members;
}

/**
 * Interview id → the other interviews it clashes with (a shared panel member, overlapping time).
 * Only rows passed in are compared; interviewExtraClauses widens its scan so earlier starts are included.
 */
export function panelOverlaps(rows) {
  const items = (rows || [])
    .map((m) => ({ m, id: idOf(m), start: new Date(m.scheduledAt).getTime(), end: endsAt(m)?.getTime(), members: panelMembers(m) }))
    .filter((x) => x.id && Number.isFinite(x.start) && Number.isFinite(x.end) && x.members.length)
    .sort((a, b) => a.start - b.start);
  const out = new Map();
  const add = (from, to, name) => {
    if (!out.has(from.id)) out.set(from.id, []);
    out.get(from.id).push({
      interviewId: to.id, candidate: to.m.candidate?.name ?? null, scheduledAt: to.m.scheduledAt ?? null, panelMember: name,
    });
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length && items[j].start < items[i].end; j += 1) {
      const keysJ = new Set(items[j].members.flatMap((p) => [...p.keys]));
      const shared = items[i].members.find((p) => [...p.keys].some((k) => keysJ.has(k)));
      if (shared) {
        add(items[i], items[j], shared.name);
        add(items[j], items[i], shared.name);
      }
    }
  }
  return out;
}

/**
 * The $and clauses resultMissing / overlapping add on top of common.js interviewMongoFilter. The overlap
 * scan runs once per tool call (window only, scoped to the viewer via queryMeetings), so count buckets reuse it.
 * "Ended" is Meeting.status 'ended': the scheduler (autoEndExpiredMeetings) sets it once the slot is over.
 */
export async function interviewExtraClauses(filters = {}, user, deps) {
  const clauses = [];
  let overlaps = null;
  if (filters.resultMissing) {
    clauses.push(ENDED_CLAUSE, { interviewResult: { $in: ['pending', null] } });
  }
  if (filters.overlapping) {
    if (!filters.scheduledBetween) {
      throw new Error('filters.overlapping needs filters.scheduledBetween (the days to check for panel clashes).');
    }
    // Same whole IST days as scheduledBetween, started MAX_DURATION_MIN early (see panelOverlaps).
    const { from, to } = dayWindowBounds(filters.scheduledBetween);
    const scheduledAt = {
      ...(from ? { $gte: new Date(new Date(from).getTime() - MAX_DURATION_MIN * 60000) } : {}),
      ...(to ? { $lte: new Date(to) } : {}),
    };
    const scan = { $and: [{ scheduledAt }, NOT_CANCELLED_CLAUSE] };
    const res = await deps.queryMeetings(scan, { limit: OVERLAP_SCAN_LIMIT, page: 1, sortBy: 'scheduledAt:asc' }, user);
    if ((res?.totalResults ?? 0) > OVERLAP_SCAN_LIMIT) {
      throw new Error(`Too many interviews in that window to check for clashes (over ${OVERLAP_SCAN_LIMIT}); use a shorter scheduledBetween.`);
    }
    overlaps = panelOverlaps(res?.results);
    clauses.push({ _id: { $in: [...overlaps.keys()] } });
  }
  return { clauses, overlaps };
}

export function withClauses(filter, clauses) {
  if (!clauses?.length) return filter;
  return { $and: [...(filter?.$and || []), ...clauses] };
}

export function detailInterviewFilter(filters, clauses) {
  return withClauses(interviewMongoFilter(filters), clauses);
}

export async function countInterviewsWith(filters, clauses, user, deps) {
  return (await deps.queryMeetings(detailInterviewFilter(filters, clauses), { limit: 1 }, user))?.totalResults ?? 0;
}

export function conflictsFor(overlaps, id) {
  if (!overlaps) return undefined;
  return (overlaps.get(id) || []).slice(0, MAX_CONFLICTS_PER_ROW);
}

// ─── One interview ──────────────────────────────────────────────────────────

const HEX_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * When the interview was scheduled. The toJSON plugin strips createdAt from every service result, so it comes
 * from the Mongo ObjectId's embedded creation time instead.
 */
export function createdAtOf(m) {
  if (m?.createdAt) return m.createdAt;
  const id = idOf(m);
  return HEX_ID_RE.test(id) ? new Date(parseInt(id.slice(0, 8), 16) * 1000) : null;
}

/** resolveJobPositionDisplayTitle returns '—' for a job id that no longer resolves, '' for none. */
export async function jobTitleFor(m, deps) {
  const title = await deps.resolveJobTitle(m.jobPosition);
  return title && title !== '—' && title !== '-' ? title : null;
}

/**
 * Meeting.jobPosition holds a Job id on most rows (the Interviews page resolves it for display), so a result
 * never shows the raw id. One lookup per distinct id on the page (<= 50 rows).
 */
export async function jobTitlesFor(rows, deps) {
  const ids = [...new Set((rows || []).map((m) => String(m.jobPosition || '').trim()).filter((v) => HEX_ID_RE.test(v)))];
  const titles = await Promise.all(ids.map((id) => jobTitleFor({ jobPosition: id }, deps)));
  const byId = new Map(ids.map((id, i) => [id, titles[i]]));
  return (m) => {
    const raw = String(m.jobPosition || '').trim();
    if (!raw) return null;
    return HEX_ID_RE.test(raw) ? byId.get(raw) ?? null : raw;
  };
}

/**
 * By id (Mongo id or meetingId) through getMeetingById (meetingScope; out of scope = 404 = notFound), or by
 * candidate name (+ job position) through the Interviews page query. Several rounds → { matches }.
 */
export async function resolveInterview({ id, candidate, jobPosition } = {}, user, deps) {
  if (id) {
    try {
      const meeting = await deps.getMeetingById(String(id), user);
      return meeting ? { meeting } : { notFound: true };
    } catch (err) {
      if (isNotFound(err)) return { notFound: true };
      throw err;
    }
  }
  const res = await deps.queryMeetings(
    interviewMongoFilter({ candidate, jobPosition }),
    { limit: MAX_MATCHES, page: 1, sortBy: 'scheduledAt:desc' },
    user,
  );
  const rows = res?.results || [];
  if (!rows.length) return { notFound: true };
  if (rows.length === 1) return { meeting: rows[0] };
  const title = await jobTitlesFor(rows, deps);
  return {
    total: res?.totalResults ?? rows.length,
    matches: rows.map((m) => ({
      id: idOf(m),
      candidate: m.candidate?.name ?? null,
      jobPosition: title(m),
      round: m.round?.label ?? null,
      scheduledAt: m.scheduledAt ?? null,
      status: m.status ?? null,
    })),
  };
}

export function interviewBrief(m, jobTitle) {
  return {
    id: idOf(m),
    candidate: m.candidate?.name ?? null,
    jobPosition: jobTitle ?? null,
    scheduledAt: m.scheduledAt ?? null,
    status: m.status ?? null,
  };
}

/**
 * The view row the portal's controller writes (writeDedupedInterviewViewAudit, same action / entity /
 * metadata), tagged source 'sage.chat'. Fire-and-forget: the answer never waits on or fails over an audit
 * row. Call it only once that content is actually being returned.
 */
export function auditView(deps, user, params) {
  try {
    Promise.resolve(deps.writeViewAudit(String(user?.id || user?._id || ''), {
      ...params,
      metadata: { ...(params.metadata || {}), source: 'sage.chat' },
    }, null)).catch(() => {});
  } catch {
    // A synchronous throw must not fail the answer either.
  }
}

export async function listRecordingsSafe(m, deps) {
  try {
    return (await deps.listRecordings(m.meetingId || idOf(m))) || [];
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** AI summary only behind the /meetings/:id/summary permission; a missing summary is null, not an error. */
export async function loadAiSummary(m, user, deps) {
  if (!(await deps.checkAccess(INTERVIEW_SUMMARY_RULE, user)).ok) return { hidden: true, summary: null };
  let s;
  try {
    s = await deps.getInterviewSummary(idOf(m), user);
  } catch (err) {
    if (isNotFound(err)) return { hidden: false, summary: null };
    throw err;
  }
  return {
    hidden: false,
    summaryId: s.summaryId ?? null,
    // interviewTranscript.controller getSummary's audit metadata.
    auditMetadata: { interviewId: s.interviewId ?? idOf(m), meetingId: s.meetingId ?? m.meetingId ?? null, evaluationVersion: s.version ?? null },
    summary: {
      executiveSummary: bound(s.executiveSummary, MAX_SUMMARY_CHARS),
      bulletSummary: (s.bulletSummary || []).slice(0, 8),
      decisions: (s.decisions || []).slice(0, 5).map((d) => d.text),
      nextSteps: (s.nextSteps || []).slice(0, 5),
      partial: !!s.partial,
      generatedAt: s.generatedAt ?? null,
    },
  };
}

export function evaluationRow(e) {
  return {
    evaluator: e.evaluatorName || null,
    weightedScore: e.weightedScore ?? null,
    coveragePct: e.coveragePct ?? null,
    isComplete: !!e.isComplete,
    submittedAt: e.submittedAt ?? null,
    comment: bound(e.comment, MAX_COMMENT_CHARS),
  };
}

/** Pre-evaluation rounds kept one embedded scorecard on the Meeting. */
export function legacyScorecard(m) {
  const sc = m.interviewScorecard;
  if (!sc?.ratings?.length) return null;
  return { scoredBy: sc.scoredBy?.name ?? null, scoredAt: sc.scoredAt ?? null, comment: bound(sc.comment, MAX_COMMENT_CHARS) };
}

export function panelOf(m) {
  const rec = m.recruiter?.name || null;
  const agents = (Array.isArray(m.agents) ? m.agents : []).map((a) => a?.name).filter((n) => n && n !== rec);
  return [
    ...(rec ? [{ name: rec, role: 'recruiter' }] : []),
    ...[...new Set(agents)].map((name) => ({ name, role: 'panel' })),
  ];
}

/** Who joined the video room (Meeting.participantRoster, on GET /meetings/:id) — joins, not RSVPs. */
export function attendanceOf(m) {
  const roster = Array.isArray(m.participantRoster) ? m.participantRoster : [];
  return roster.slice(0, MAX_ATTENDEES).map((p) => ({
    name: p.displayName || null,
    role: p.role || null,
    firstJoinedAt: p.firstJoinedAt ?? null,
  }));
}

/**
 * Result changes and invitation re-sends from the Activity Logs page, behind that page's own gate and grading
 * (requireActivityLogsListAccess; resolveActivityLogListFilter: full access = everyone's rows, else your own).
 * Rows are keyed by the id the portal was called with — Mongo id or meetingId — so both are matched.
 */
export async function loadInterviewHistory(m, user, deps) {
  if (!(await passesGate(deps.activityGate, user))) return { hidden: true };
  const tier = activityTier(user, deps);
  const ids = [...new Set([idOf(m), m.meetingId].filter(Boolean).map(String))];
  const page = await deps.queryActivityLogs(
    {
      ...tier.resolve({}),
      entityType: EntityTypes.MEETING,
      action: { $in: Object.keys(HISTORY_ACTIONS) },
      $or: ids.map((entityId) => ({ entityId })),
    },
    { limit: MAX_HISTORY, page: 1, sortBy: 'createdAt:desc' },
    user,
  );
  const rows = (page?.results || []).map((r) => {
    const change = (r.metadata?.changes || []).find((c) => c?.field === 'interviewResult');
    return {
      event: HISTORY_ACTIONS[r.action] ?? r.action,
      by: r.actor?.name ?? null,
      at: r.createdAt ?? null,
      ...(change ? { from: change.from ?? null, to: change.to ?? null } : {}),
    };
  });
  return { rows, total: page?.totalResults ?? rows.length, scope: tier.seesEveryone ? 'everyone' : 'your own actions only' };
}

// ─── Transcript ─────────────────────────────────────────────────────────────

export async function canLookUpInterviews(user, deps) {
  return (await deps.checkAccess(INTERVIEW_LOOKUP_RULE, user)).ok;
}

// getInterviewTranscript's sanitizeUtterance shape: displayName, speakerRole, recordingOffsetMs,
// startedAtEpochMs, endedAtEpochMs, text — already in spoken order (transcript assembly sorts them).
const speakerOf = (u) => u.displayName || (u.speakerRole && u.speakerRole !== 'unknown' ? u.speakerRole : null) || 'Unknown speaker';
const spokenMs = (u) => {
  const ms = Number(u.endedAtEpochMs) - Number(u.startedAtEpochMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
const clock = (ms) => {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const s = Math.floor(Number(ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Speaker totals plus up to MAX_TRANSCRIPT_WINDOWS consecutive chunks, each with its speakers and an excerpt. */
export function summarizeUtterances(utterances) {
  const speakers = new Map();
  for (const u of utterances) {
    const name = speakerOf(u);
    const s = speakers.get(name) || { name, role: null, utterances: 0, spokenMs: 0 };
    s.utterances += 1;
    if (!s.role && u.speakerRole && u.speakerRole !== 'unknown') s.role = u.speakerRole;
    s.spokenMs += spokenMs(u);
    speakers.set(name, s);
  }
  const size = Math.max(10, Math.ceil(utterances.length / MAX_TRANSCRIPT_WINDOWS));
  const windows = [];
  for (let i = 0; i < utterances.length; i += size) {
    const chunk = utterances.slice(i, i + size);
    const last = chunk[chunk.length - 1];
    const lastEnd = last.recordingOffsetMs == null ? null : Number(last.recordingOffsetMs) + spokenMs(last);
    windows.push({
      from: clock(chunk[0].recordingOffsetMs),
      to: clock(lastEnd),
      utterances: chunk.length,
      speakers: [...new Set(chunk.map(speakerOf))],
      excerpt: bound(chunk.map((u) => `${speakerOf(u)}: ${u.text || ''}`).join(' '), MAX_EXCERPT_CHARS),
    });
  }
  return { speakers: [...speakers.values()], windows };
}

/** Whole utterances up to MAX_FULL_TEXT_CHARS; a first utterance longer than the cap is cut, never dropped. */
export function fullTranscriptText(utterances) {
  let text = '';
  let shown = 0;
  for (const u of utterances) {
    const at = clock(u.recordingOffsetMs);
    const line = `${at ? `[${at}] ` : ''}${speakerOf(u)}: ${u.text || ''}\n`;
    if (text.length + line.length > MAX_FULL_TEXT_CHARS) {
      if (!shown) text = `${line.slice(0, MAX_FULL_TEXT_CHARS - 1)}…`;
      break;
    }
    text += line;
    shown += 1;
  }
  return { fullText: text.trimEnd(), shownUtterances: shown, truncated: shown < utterances.length };
}
