import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  NOT_CAPTURED, MAX_ROWS, personScope, composeDeps, istToday, lastIstDays, sameName, pick,
  restricted, notRecorded, notCaptured, okSection, ambiguousSection, failedSection,
} from './common.js';

export const SECTIONS = [
  'profile', 'referral', 'applications', 'calls', 'interviews', 'offer', 'placement', 'documents',
  'org', 'attendance', 'leave', 'training', 'work', 'activity', 'externalJobs',
];
const FOCUS = ['today', 'pending'];

// One resolve step, then every section in parallel: 5 s + 8 s stays under the tool's own 15 s.
const TOOL_TIMEOUT_MS = 15000;
const RESOLVE_TIMEOUT_MS = 5000;
const SECTION_TIMEOUT_MS = 8000;
const ATTENDANCE_DAYS = 30;
// Rows read where the section filters them itself (exact name, open tasks, projects from tasks).
const SCAN_LIMIT = 50;
const PENDING_OFFER_STATUSES = ['Sent', 'Under Negotiation'];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const EXTERNAL_JOBS_NOTE =
  `External-job (bench marketing) activity is ${NOT_CAPTURED} per person — External Jobs only record which ` +
  'staff user saved a listing, not who was marketed to it.';
const USERS_READ_NOTE = 'Looking a person up by name needs the Users directory permission (users.read).';

const EMPLOYEE_FIELDS = ['employeeId', 'designation', 'department', 'position', 'joiningDate', 'employmentStatus',
  'reportingManager'];
const CANDIDATE_FIELDS = ['designation', 'department', 'joiningDate'];

// ─── Resolve the person once ─────────────────────────────────────────────────

function visibleFields(profile, keys) {
  if (profile.error) return { error: 'could not load' };
  if (profile.noRecord) return { noRecord: true };
  const redacted = new Set(profile.redacted || []);
  return Object.fromEntries(keys.filter((k) => !redacted.has(k)).map((k) => [k, profile.fields?.[k] ?? null]));
}

function roleNames(r) {
  return r.identity?.roles?.length ? r.identity.roles : (r.roles || []).map((role) => role.name).filter(Boolean);
}

function profileSection(r) {
  const p = r.profiles || {};
  const others = Object.keys(p).filter((k) => k !== 'employee' && k !== 'candidate');
  return okSection({
    name: r.identity?.name ?? null,
    email: r.identity?.email ?? null,
    roles: roleNames(r),
    ...(p.employee ? { employee: visibleFields(p.employee, EMPLOYEE_FIELDS) } : {}),
    ...(p.candidate ? { candidate: visibleFields(p.candidate, CANDIDATE_FIELDS) } : {}),
    ...(others.length ? { otherProfiles: others } : {}),
    ...(r.profileNote ? { profileNote: r.profileNote } : {}),
  });
}

/** Roles decide which sections apply — from the profile's own role list, never guessed from data. */
function targetFrom(r, viewer) {
  const slugs = new Set(
    [...(r.roles || []).map((role) => role?.slug), ...(r.identity?.roleSlugs || [])]
      .filter(Boolean).map((s) => String(s).toLowerCase()),
  );
  const userId = r.identity?.userId != null ? String(r.identity.userId) : null;
  const name = r.identity?.name ?? null;
  // Login name plus profile names: rows keyed by a profile's fullName (callbacks) may spell it differently.
  const profileNames = Object.values(r.profiles || {}).map((p) => p?.fields?.name).filter(Boolean);
  return {
    userId,
    name,
    names: [...new Set([name, ...profileNames].filter(Boolean))],
    email: r.identity?.email ?? null,
    roles: roleNames(r),
    candidate: slugs.has('candidate'),
    employee: slugs.has('employee'),
    self: !!userId && userId === String(viewer.id ?? viewer._id),
  };
}

/** get_user's name rules (no platform-super, no deleted, exact match wins); omitted person = get_my_profile. */
async function resolveTarget(person, viewer, runTool) {
  const q = person?.trim();
  const outcome = q
    ? await runTool('get_user', OBJECT_ID_RE.test(q) ? { id: q } : { name: q }, { timeoutMs: RESOLVE_TIMEOUT_MS })
    : await runTool('get_my_profile', {}, { timeoutMs: RESOLVE_TIMEOUT_MS });
  const failed = failedSection(outcome, { errorIsRestricted: false });
  if (failed) {
    return {
      stop: {
        resolved: false, searchedFor: q ?? null, profile: failed,
        ...(failed.status === 'restricted' ? { note: USERS_READ_NOTE } : {}),
      },
    };
  }
  const r = outcome.result;
  if (r.matches) return { stop: r.matches.length ? { matches: r.matches } : { notFound: true, searchedFor: q } };
  if (r.kind !== 'unique') return { stop: { resolved: false, searchedFor: q ?? null, profile: { status: 'error', error: 'profile unavailable' } } };
  return { target: targetFrom(r, viewer), profile: profileSection(r) };
}

// ─── Section arguments ───────────────────────────────────────────────────────

// Email when known (narrower than a name), else the name. These lookups are substring searches, so each
// section keeps only records under the person's exact name.
const lookup = (t) => t.email || t.name;
const personArg = (t) => (t.self ? {} : { person: lookup(t) });
// Attendance and leave hang off the login, so they get the exact user id rather than a name or email search.
const loginArg = (t) => (t.self ? {} : { person: t.userId });
const leavePerson = (t) => (t.self ? { mine: true } : { person: t.userId });
const assignee = (t) => (t.self ? { assignedToMe: true } : { assigneeUserId: t.userId });
const needsName = (t) => (t.name && t.name.trim().length >= 2 ? null : notRecorded('No name on record to search by.'));

function roleSkip(only, t) {
  if (only === 'candidate' && t.employee && !t.candidate) {
    return notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.');
  }
  if (only === 'employee' && t.candidate && !t.employee) {
    return notRecorded('Employee-only section — they hold the Candidate role, not the Employee role.');
  }
  return null;
}

// ─── Section builders (one tool result → { status, summary, rows ≤ 5 }) ─────

const exactRows = (r, field, name) => (r.records || []).filter((x) => sameName(x[field], name));
const scanTruncated = (r) => (r.total ?? 0) > (r.records || []).length;

function referralSection(r, t) {
  // get_referral matches the email or name partially; keep only leads under this person's exact name.
  const own = (r.records || []).filter((x) => sameName(x.candidate, t.name));
  if (own.length) {
    return okSection({ total: own.length }, own.map((x) => pick(x, ['referredBy', 'salesAgent', 'channel', 'job', 'referredAt', 'status'])));
  }
  // Outside the viewer's Refer Leads scope: whether anyone referred them is not theirs to see.
  if (r.referred === null) return restricted();
  if (r.direct?.length) return okSection({ referred: false, note: r.note });
  if (r.unlisted?.length) return okSection({ referred: true, note: r.unlistedNote });
  return notRecorded('No referral lead on record.');
}

// applicantUserId matches this person's own candidate profiles exactly, so total is theirs.
function applicationsSection(r) {
  if (r.notFound || !r.total) return notRecorded('No job applications on record.');
  return okSection({ total: r.total }, (r.records || []).map((x) => pick(x, ['job', 'status', 'appliedAt'])));
}

function callsSection([list, metrics], t) {
  const failed = failedSection(list);
  if (failed) return failed;
  const r = list.result;
  const rows = exactRows(r, 'person', t.name);
  if (!r.total || !rows.length) return notRecorded('No call records under this name.');
  const mf = failedSection(metrics);
  return okSection({
    total: r.total,
    ...(mf ? { metrics: mf.status } : pick(metrics.result, ['answeredCalls', 'answerRate', 'avgDurationSeconds', 'failedCalls'])),
    matchedBy: 'name, like the Call Records search box — total and metrics count every call whose name contains theirs',
  }, rows.map((x) => pick(x, ['when', 'callType', 'status', 'durationSeconds', 'outcome'])));
}

function interviewsSection(o, t, empty) {
  const failed = failedSection(o);
  if (failed) return failed;
  const r = o.result;
  const rows = exactRows(r, 'candidate', t.name);
  const cut = scanTruncated(r) ? { scanTruncated: true, note: `Only the first ${(r.records || []).length} name matches were read.` } : {};
  if (!rows.length) return notRecorded(cut.note ?? empty);
  return okSection({ total: rows.length, ...cut }, rows.map((x) => pick(x, ['jobPosition', 'scheduledAt', 'status', 'result', 'interviewers'])));
}

// get_offer / get_placement search the email or name as a substring and return a lone hit as THE record,
// so a hit is this person's only when it carries their exact name.
function theirMatches(r, t, tool, empty) {
  const own = r.matches.filter((m) => sameName(m.candidate, t.name));
  return own.length ? ambiguousSection(own, tool) : notRecorded(empty);
}

function offerSection(r, t) {
  if (r.notFound) return notRecorded('No offer on record.');
  if (r.matches) return theirMatches(r, t, 'get_offer', 'No offer on record.');
  if (!sameName(r.candidate, t.name)) return notRecorded('No offer on record.');
  return okSection(pick(r, ['offerCode', 'job', 'status', 'sentAt', 'acceptedAt', 'rejectedAt', 'joiningDate', 'daysPending', 'markedSentBy']));
}

function placementSection(r, t) {
  if (r.notFound) return notRecorded('No placement on record.');
  if (r.matches) return theirMatches(r, t, 'get_placement', 'No placement on record.');
  if (!sameName(r.candidate, t.name)) return notRecorded('No placement on record.');
  return okSection(pick(r, ['status', 'job', 'joiningDate', 'firstBlockingStep', 'holdsEmployeeRole', 'department', 'designation']));
}

function documentsSection(r) {
  if (r.notFound) return notRecorded('No candidate or employee profile with documents.');
  if (r.matches) return ambiguousSection(r.matches, 'list_documents');
  const docs = r.documents || [];
  const missing = r.missing || [];
  if (!docs.length && !missing.length) return notRecorded('No documents uploaded or requested.');
  return okSection({
    counts: r.counts ?? null,
    missing: missing.slice(0, MAX_ROWS).map((m) => m.label || m.type),
    expiringSoon: (r.expiries || []).filter((e) => e.expiringSoon).length,
  }, docs.map((d) => pick(d, ['type', 'label', 'status'])));
}

function orgSection(r) {
  if (r.notFound) return notRecorded(r.note || 'Not on the org chart.');
  if (r.ambiguous) return ambiguousSection((r.matches || []).map((name) => ({ name })), 'get_reporting_chain');
  return okSection({
    designation: r.designation ?? null,
    chain: (r.chain || []).slice(0, MAX_ROWS).map((c) => pick(c, ['level', 'unit', 'head'])),
    ...(r.chainNote ? { chainNote: r.chainNote } : {}),
    reportingManager: r.reportingManager ?? null,
    ...(r.reportingManagerNote ? { reportingManagerNote: r.reportingManagerNote } : {}),
    ...(r.teams ? { teams: r.teams.slice(0, MAX_ROWS) } : {}),
    ...(r.teamsNote ? { teamsNote: r.teamsNote } : {}),
  });
}

function attendanceSection(r, empty) {
  if (r.notFound) return notRecorded('No employee profile to read attendance from.');
  if (r.matches?.length) return ambiguousSection(r.matches, 'get_attendance');
  if (!r.total) return notRecorded(empty);
  return okSection(
    { window: r.window, total: r.total, statusBreakdown: r.statusBreakdown },
    (r.records || []).map((x) => pick(x, ['date', 'status', 'punchIn', 'punchOut', 'hours'])),
  );
}

function leaveSection(r, empty) {
  if (r.notFound) return notRecorded('No employee profile to read leave from.');
  if (r.matches?.length) return ambiguousSection(r.matches, 'list_leave_requests');
  if (!r.total) return notRecorded(empty);
  return okSection({ total: r.total }, (r.records || []).map((x) => pick(x, ['leaveType', 'status', 'from', 'to', 'days'])));
}

function trainingSection(r) {
  if (r.noStudentProfile) return notRecorded(r.note);
  if (r.matches) return r.matches.length ? ambiguousSection(r.matches, 'get_training_progress') : notRecorded('No training record.');
  if (!r.total) return notRecorded('No courses assigned.');
  const courses = r.courses || [];
  return okSection({
    total: r.total,
    completed: courses.filter((c) => c.status === 'completed').length,
    ...(r.total > courses.length ? { completedCoversFirst: courses.length } : {}),
  }, courses.map((c) => pick(c, ['module', 'status', 'percentage'])));
}

const taskRows = (records) => records.map((x) => pick(x, ['code', 'title', 'status', 'dueDate', 'project']));
const completedCount = (c) => (c.groups || []).find((g) => g.value === 'completed')?.count ?? 0;

function workSection([count, list, projects]) {
  const failed = failedSection(count);
  if (failed) return failed;
  const c = count.result;
  const lf = failedSection(list);
  const tasks = lf ? [] : list.result.records || [];
  const pf = projects ? failedSection(projects) : null;
  const named = projects && !pf ? projects.result : null;
  if (!c.total && !named?.total) return notRecorded('No tasks assigned, and no project names them.');
  return okSection({
    tasks: { total: c.total ?? 0, open: (c.total ?? 0) - completedCount(c), overdue: c.overdue ?? null, blocked: c.blocked ?? null },
    projectsFromTasks: [...new Set(tasks.map((x) => x.project).filter(Boolean))].slice(0, MAX_ROWS),
    projectsFromTasksBasis: `projects of their ${tasks.length} newest tasks`,
    projectsNamingThem: pf
      ? { status: pf.status }
      : named && { total: named.total ?? 0, names: (named.records || []).slice(0, MAX_ROWS).map((p) => p.name) },
    ...(lf ? { taskRows: lf.status } : {}),
  }, taskRows(tasks));
}

function activitySection(outs) {
  const verdicts = outs.map((o) => {
    const failed = failedSection(o);
    if (failed) return failed;
    // A viewer who only sees their own log rows loses the record filter — the rows would not be about this person.
    return (o.result.ignoredFilters || []).includes('target') ? restricted() : null;
  });
  const good = outs.filter((_, i) => !verdicts[i]);
  if (!good.length) return verdicts[0] ?? notRecorded('No activity log rows about this person.');
  const total = good.reduce((n, o) => n + (o.result.total || 0), 0);
  if (!total) return notRecorded('No activity log rows about this person.');
  const rows = good.flatMap((o) => o.result.records || []).sort((a, b) => new Date(b.at) - new Date(a.at));
  const ownOnly = good.some((o) => o.result.scope === 'your own activity only');
  return okSection({
    total,
    matchedBy: 'their login account, and person records whose name starts with theirs (Activity Logs page rules)',
    ...(ownOnly ? { note: 'Only your own actions are visible to you.' } : {}),
  }, rows.map((a) => pick(a, ['at', 'actor', 'action', 'target'])));
}

function tasksSection(r, empty) {
  if (!r.total) return notRecorded(empty);
  return okSection({ total: r.total }, taskRows(r.records || []));
}

function meetingsSection(r) {
  if (!r.total) return notRecorded('No meetings today.');
  return okSection({ total: r.total }, (r.records || []).map((m) => pick(m, ['title', 'scheduledAt', 'status'])));
}

function openTasksSection([count, list]) {
  const failed = failedSection(count);
  if (failed) return failed;
  const c = count.result;
  const open = (c.total ?? 0) - completedCount(c);
  if (!open) return notRecorded('No open tasks.');
  const lf = failedSection(list);
  const rows = lf ? [] : (list.result.records || []).filter((x) => x.status !== 'completed');
  return okSection({ open, overdue: c.overdue ?? null, blocked: c.blocked ?? null, ...(lf ? { taskRows: lf.status } : {}) }, taskRows(rows));
}

function missingDocumentsSection(r) {
  if (r.notFound) return notRecorded('No candidate or employee profile with documents.');
  if (r.matches) return ambiguousSection(r.matches, 'list_documents');
  const missing = r.missing || [];
  if (!missing.length) return notRecorded('No requested documents outstanding.');
  return okSection({ missing: missing.length }, missing.map((m) => pick(m, ['label', 'type', 'requestedBy', 'requestedAt'])));
}

/**
 * list_call_followups has no person filter, so the person's rows are picked out of the first SCAN_LIMIT
 * callbacks by exact applicant name. ponytail: past SCAN_LIMIT open callbacks in the viewer's scope the
 * answer says it only read that many; upgrade = an applicant filter on list_call_followups.
 */
function callbacksSection([due, overdue], t) {
  const verdicts = [due, overdue].map((o) => failedSection(o));
  if (verdicts[0] && verdicts[1]) return verdicts[0];
  const rowsOf = (o, i, isOverdue) => (verdicts[i] ? [] : (o.result.records || [])
    .filter((x) => t.names.some((n) => sameName(x.applicant, n)))
    .map((x) => ({ ...pick(x, ['job', 'callbackAt', 'applicationStatus']), overdue: isOverdue })));
  const dueRows = rowsOf(due, 0, false);
  const overdueRows = rowsOf(overdue, 1, true);
  const truncated = [due, overdue].some((o, i) => !verdicts[i] && scanTruncated(o.result));
  const cut = truncated ? { scanTruncated: true, note: `Only the first ${SCAN_LIMIT} callbacks of each kind were read.` } : {};
  if (!dueRows.length && !overdueRows.length) return notRecorded(cut.note ?? 'No callbacks due.');
  return okSection({
    due: dueRows.length,
    overdue: overdueRows.length,
    ...cut,
    ...(verdicts[0] ? { dueStatus: verdicts[0].status } : {}),
    ...(verdicts[1] ? { overdueStatus: verdicts[1].status } : {}),
  }, [...overdueRows, ...dueRows]);
}

function offerPendingSection(r, t) {
  if (r.notFound) return notRecorded('No offer on record.');
  if (r.matches) {
    const open = r.matches.filter((m) => PENDING_OFFER_STATUSES.includes(m.status) && sameName(m.candidate, t.name));
    return open.length ? ambiguousSection(open, 'get_offer') : notRecorded('No offer waiting on the candidate.');
  }
  if (!sameName(r.candidate, t.name)) return notRecorded('No offer on record.');
  if (!PENDING_OFFER_STATUSES.includes(r.status)) {
    return notRecorded(`No offer waiting on the candidate (latest offer: ${r.status ?? 'unknown status'}).`);
  }
  return okSection(pick(r, ['offerCode', 'job', 'status', 'sentAt', 'daysPending', 'validUntil']));
}

// ─── Section plans ───────────────────────────────────────────────────────────
// Each: `only` (candidate / employee), `unavailable(t)` → a section when it cannot run,
// `calls(t)` → runTool calls, `build(outcomes, t)` → the section.

const one = (fn) => ([o], t) => failedSection(o) ?? fn(o.result, t);

function fullPlan(attendanceWindow) {
  return {
    referral: {
      only: 'candidate',
      unavailable: needsName,
      calls: (t) => [{ name: 'get_referral', args: { person: lookup(t), limit: MAX_ROWS } }],
      build: one(referralSection),
    },
    applications: {
      calls: (t) => [{ name: 'list_applications', args: { filters: { applicantUserId: t.userId }, limit: MAX_ROWS } }],
      build: one(applicationsSection),
    },
    calls: {
      unavailable: needsName,
      calls: (t) => [
        { name: 'list_call_records', args: { filters: { person: t.name }, limit: SCAN_LIMIT } },
        { name: 'get_call_metrics', args: { filters: { person: t.name } } },
      ],
      build: callsSection,
    },
    interviews: {
      unavailable: needsName,
      calls: (t) => [{ name: 'list_interviews', args: { filters: { candidate: t.name }, limit: SCAN_LIMIT } }],
      build: ([o], t) => interviewsSection(o, t, 'No interviews on record.'),
    },
    offer: {
      only: 'candidate',
      unavailable: needsName,
      calls: (t) => [{ name: 'get_offer', args: { candidate: lookup(t) } }],
      build: one(offerSection),
    },
    placement: {
      only: 'candidate',
      unavailable: needsName,
      calls: (t) => [{ name: 'get_placement', args: { candidate: lookup(t) } }],
      build: one(placementSection),
    },
    documents: {
      only: 'candidate',
      calls: (t) => [{ name: 'list_documents', args: personArg(t) }],
      build: one(documentsSection),
    },
    org: {
      only: 'employee',
      unavailable: needsName,
      calls: (t) => [{ name: 'get_reporting_chain', args: { mode: 'chain', person: t.name } }],
      build: one(orgSection),
    },
    attendance: {
      only: 'employee',
      calls: (t) => [{ name: 'get_attendance', args: { ...loginArg(t), window: attendanceWindow, limit: MAX_ROWS } }],
      build: one((r) => attendanceSection(r, `No attendance rows in the last ${ATTENDANCE_DAYS} days.`)),
    },
    leave: {
      only: 'employee',
      calls: (t) => [{ name: 'list_leave_requests', args: { filters: leavePerson(t), limit: MAX_ROWS } }],
      build: one((r) => leaveSection(r, 'No leave requests on record.')),
    },
    training: {
      calls: (t) => [{ name: 'get_training_progress', args: { mode: 'person', ...personArg(t), limit: SCAN_LIMIT } }],
      build: one(trainingSection),
    },
    work: {
      only: 'employee',
      calls: (t) => [
        { name: 'count_tasks', args: { filters: assignee(t), groupBy: 'status' } },
        { name: 'list_tasks', args: { filters: assignee(t), limit: SCAN_LIMIT } },
        ...(t.name ? [{ name: 'list_projects', args: { filters: { search: t.name }, limit: MAX_ROWS } }] : []),
      ],
      build: workSection,
    },
    activity: {
      calls: (t) => [
        ...((t.candidate || t.employee) && t.name
          ? [{ name: 'list_activity', args: { filters: { targetType: 'Employee', target: t.name }, limit: MAX_ROWS } }]
          : []),
        ...(t.userId ? [{ name: 'list_activity', args: { filters: { targetType: 'User', target: t.userId }, limit: MAX_ROWS } }] : []),
      ],
      build: activitySection,
    },
    externalJobs: { unavailable: () => notCaptured(EXTERNAL_JOBS_NOTE) },
  };
}

function todayPlan(today) {
  const day = { from: today, to: today };
  return {
    attendanceToday: {
      only: 'employee',
      calls: (t) => [{ name: 'get_attendance', args: { ...loginArg(t), window: day, limit: MAX_ROWS } }],
      build: one((r) => attendanceSection(r, 'No attendance row for today yet.')),
    },
    tasksDueToday: {
      only: 'employee',
      calls: (t) => [{ name: 'list_tasks', args: { filters: { ...assignee(t), dueBetween: day }, sort: 'dueDate', limit: MAX_ROWS } }],
      build: one((r) => tasksSection(r, 'No tasks due today.')),
    },
    leaveToday: {
      only: 'employee',
      calls: (t) => [{ name: 'list_leave_requests', args: { filters: { ...leavePerson(t), dates: day, status: 'approved' }, limit: MAX_ROWS } }],
      build: one((r) => leaveSection(r, 'Not on approved leave today.')),
    },
    meetingsToday: {
      // Internal meetings are readable only for the viewer themself.
      unavailable: (t) => (t.self ? null : restricted("Other people's meetings are not readable.")),
      calls: () => [{ name: 'list_meetings', args: { filters: { mine: true, scheduledBetween: day }, limit: MAX_ROWS } }],
      build: ([o]) => failedSection(o, { errorIsRestricted: false }) ?? meetingsSection(o.result),
    },
  };
}

const PENDING_PLAN = {
  openTasks: {
    only: 'employee',
    calls: (t) => [
      { name: 'count_tasks', args: { filters: assignee(t), groupBy: 'status' } },
      { name: 'list_tasks', args: { filters: assignee(t), sort: 'dueDate', limit: SCAN_LIMIT } },
    ],
    build: openTasksSection,
  },
  pendingLeave: {
    only: 'employee',
    calls: (t) => [{ name: 'list_leave_requests', args: { filters: { ...leavePerson(t), status: 'pending' }, limit: MAX_ROWS } }],
    build: one((r) => leaveSection(r, 'No leave requests waiting for approval.')),
  },
  missingDocuments: {
    only: 'candidate',
    calls: (t) => [{ name: 'list_documents', args: personArg(t) }],
    build: one(missingDocumentsSection),
  },
  callbacksDue: {
    unavailable: needsName,
    calls: () => [
      { name: 'list_call_followups', args: { kind: 'callbackRequested', limit: SCAN_LIMIT } },
      { name: 'list_call_followups', args: { kind: 'callbackOverdue', limit: SCAN_LIMIT } },
    ],
    build: callbacksSection,
  },
  interviewsAwaitingResult: {
    unavailable: needsName,
    calls: (t) => [{ name: 'list_interviews', args: { filters: { candidate: t.name, resultMissing: true }, limit: SCAN_LIMIT } }],
    build: ([o], t) => interviewsSection(o, t, 'No ended interview waiting for a result.'),
  },
  offerPending: {
    only: 'candidate',
    unavailable: needsName,
    calls: (t) => [{ name: 'get_offer', args: { candidate: lookup(t) } }],
    build: one(offerPendingSection),
  },
};

/** Runs every applicable section's calls in one parallel batch; a section that throws while building is an error, not a failed 360. */
async function runPlan(plan, t, runTools) {
  const sections = {};
  const planned = [];
  for (const [key, spec] of Object.entries(plan)) {
    const skip = roleSkip(spec.only, t) ?? spec.unavailable?.(t) ?? null;
    if (skip) sections[key] = skip;
    else planned.push({ key, spec, calls: spec.calls(t) });
  }
  const outcomes = await runTools(planned.flatMap((p) => p.calls.map((c) => ({ ...c, timeoutMs: SECTION_TIMEOUT_MS }))));
  let i = 0;
  for (const p of planned) {
    const outs = outcomes.slice(i, i + p.calls.length);
    i += p.calls.length;
    try {
      sections[p.key] = p.spec.build(outs, t);
    } catch (err) {
      sections[p.key] = { status: 'error', error: err?.message || String(err) };
    }
  }
  return Object.fromEntries(Object.keys(plan).map((k) => [k, sections[k]]));
}

const LABELS = {
  externalJobs: 'external jobs', attendanceToday: 'attendance today', tasksDueToday: 'tasks due today',
  leaveToday: 'leave today', meetingsToday: 'my meetings today', openTasks: 'open tasks', pendingLeave: 'pending leave',
  missingDocuments: 'missing documents', callbacksDue: 'callbacks due', interviewsAwaitingResult: 'interviews awaiting result',
  offerPending: 'offer pending', work: 'projects / tasks',
};

export default defineTool({
  name: 'get_person_360',
  domain: 'person',
  kind: 'read',
  description:
    'Everything about ONE person in one call: profile, referral, job applications, AI calls, interviews, offer, ' +
    'placement and its blocking step, documents, org chain, attendance (last 30 days), leave, training, projects / ' +
    'tasks and activity about them. Use for "tell me everything about X", "give me a 360 of X", "full picture of X", ' +
    '"what is X doing today" (focus today), "does X have pending actions / what is pending for X" (focus pending). ' +
    'Omit person for the signed-in user ("what is pending for me"). NOT for one fact — "who is X\'s manager / team ' +
    'lead", "which department is X in", "when did X join" go to that module\'s own tool (get_reporting_chain, ' +
    'get_user). A name that fits several people returns { matches } to ask which one.',
  measure:
    'One person across modules. Each section is that module\'s own tool under your access and its own measure; ' +
      'rows are at most 5, total is the full count. Referral, offer, placement and documents are skipped for someone ' +
      'with the Employee role but not the Candidate role; org, attendance, leave and projects / tasks for someone ' +
      'with the Candidate role but not the Employee role.',
  input: Joi.object({
    person: Joi.string().min(1).max(200)
      .description('Name, email or user id of the person. Omit for the signed-in user. NEVER a pronoun — resolve it from the conversation first.'),
    sections: Joi.array().items(Joi.string().valid(...SECTIONS)).min(1).max(SECTIONS.length).unique()
      .description('Only these sections (default: every section). Ignored when focus is set.'),
    focus: Joi.string().valid(...FOCUS)
      .description('today = attendance, tasks due and leave today (plus your own meetings when the person is you); ' +
        'pending = open tasks, pending leave, missing documents, callbacks due, interviews awaiting a result, offer pending.'),
  }),
  access: { note: 'each section runs its own tool under the viewer\'s access (compose.js runTool); resolving a name needs users.read' },
  timeoutMs: TOOL_TIMEOUT_MS,
  async execute({ person, sections, focus } = {}, ctx) {
    const viewer = personScope(ctx);
    const { runTool, runTools, now } = composeDeps(ctx);
    const resolved = await resolveTarget(person, viewer, runTool);
    if (resolved.stop) return resolved.stop;
    const t = resolved.target;
    const today = istToday(now());

    let out;
    if (focus === 'today') {
      out = await runPlan(todayPlan(today), t, runTools);
    } else if (focus === 'pending') {
      out = await runPlan(PENDING_PLAN, t, runTools);
    } else {
      const wanted = new Set(sections?.length ? sections : SECTIONS);
      const plan = Object.fromEntries(Object.entries(fullPlan(lastIstDays(ATTENDANCE_DAYS, now()))).filter(([k]) => wanted.has(k)));
      out = { ...(wanted.has('profile') ? { profile: resolved.profile } : {}), ...(await runPlan(plan, t, runTools)) };
    }

    return {
      person: pick(t, ['userId', 'name', 'roles', 'self', 'candidate', 'employee']),
      focus: focus ?? 'all',
      today,
      sections: out,
    };
  },
  render(result) {
    if (!result?.sections) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'person-360',
        tableType: 'person-360',
        title: `${result.person?.name ?? 'Person'} — ${result.focus === 'all' ? 'overview' : result.focus}`,
        columns: [
          { key: 'section', label: 'Section', priority: 'primary' },
          { key: 'status', label: 'Status', priority: 'primary' },
          { key: 'total', label: 'Total', priority: 'secondary' },
        ],
        rows: Object.entries(result.sections).map(([key, s]) => ({
          section: LABELS[key] ?? key,
          status: s?.status ?? '—',
          total: s?.summary?.total != null ? String(s.summary.total) : '—',
        })),
        layout: 'auto',
      }],
    };
  },
});
