import { toApiFilter } from '../../../../../schemas/employees/employeeQuery.scope.js';
import { OPEN_TASK_STATUSES } from '../../../taskAccess.js';
import { leaveDatesWindowClause } from '../../../attendanceAnalytics.js';
import { ORG_READ_PERMISSIONS } from '../../../orgStructureAnalytics.js';
import { WORKLOAD_ACCESS, taskViewerScope } from '../projects/common.js';
import { INTERVIEWS_ACCESS, OFFERS_ACCESS, PLACEMENTS_ACCESS } from '../hiring/common.js';
import { DOCUMENTS_ACCESS, PAPERWORK_COMPLETE_MATCH, canViewOthersDocuments } from '../hiring/placementDetail.js';
import { COHORT_ACCESS } from '../training/common.js';
import { dayKeys } from '../attendance/common.js';
import { APPLICATIONS_PAGE_PERMISSION } from '../calls/followups.js';
import {
  OBJECT_ID_RE, idOf, allowed, visibilityToMongo, cappedRows, okSet, restrictedSet, notCapturedSet,
  composedFailure, istBounds, istDayOf,
} from './common.js';
import { studentsToUsers, emailsToUsers, employeeCodesToUsers, mapSet } from './identity.js';

/*
 * Id-set builders. Each returns an ok set { ids, info, total, truncated, unmapped } or a restricted /
 * notCaptured / error section, and reads through the SAME scope the Wave 1 tool for that page uses:
 *   allocation   → get_allocation's Employees-page population + projectCapacity.countActiveProjectsByAssignee
 *   tasks        → taskViewerScope (org-wide board only) + taskAccess.buildAccessibleTaskFilter
 *   training     → the Training → Evaluation rows (evaluation.service getEvaluationData, evaluation.read)
 *   placements   → placement.service buildPlacementVisibilityClause
 *   offers       → offer.service buildOfferVisibilityClause
 *   interviews   → visibilityScope.meetingScope (+ internalMeetingScope for internal meetings)
 *   leave        → leaveRequest.service buildLeaveRequestScopeFilter + attendanceAnalytics leaveDatesWindowClause
 *   absent       → get_attendance_summary (composed)
 *   org chart    → orgStructure.service buildTree (get_reporting_chain's chart population)
 *   documents    → hiring PAPERWORK_COMPLETE_MATCH behind the pre-boarding documents gate
 *   applications → applicantQuery.service buildApplicantQuery
 * A viewer without a set's page permission gets `restricted` for that set, and so for the whole check.
 * `partialScope` says when the page itself shows this viewer only part of the rows.
 *
 * ponytail: each builder is one id-only read (or one service call) capped at SET_CAP rows. No Wave 1 tool
 * returns a full id list (they return ≤ 50 rows), so the checks cannot be composed from tool results alone.
 */

const env = (e) => ({ user: e.user, deps: e.deps });
const validIds = (ids) => [...ids].map(String).filter((id) => OBJECT_ID_RE.test(id));

// ─── People / projects / tasks ──────────────────────────────────────────────

/** Current employees (Employees-page scope) with an active-project count inside [minProjects, maxProjects]. */
export async function allocationSet(e, { minProjects = 0, maxProjects = Infinity, label = 'Projects' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(WORKLOAD_ACCESS, user, deps))) return restrictedSet(label, `Requires one of: ${WORKLOAD_ACCESS.anyOf.join(', ')}.`);
  const filters = { ownerUserRole: 'employee' };
  const auth = deps.authorizeEmployeeQuery({ entity: 'employees', operations: ['count'], filters }, user);
  if (!auth?.allowed) return restrictedSet(label, auth?.error);
  const apiFilter = await deps.applyEmployeeListScope(toApiFilter(filters), user, user.authContext);
  const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
  const { rows, truncated } = await cappedRows(deps.Employee.find(mongoFilter).select('designation owner'));
  const withLogin = rows.filter((r) => r.owner);
  const counts = await deps.countActiveProjects(withLogin.map((r) => idOf(r.owner)));
  const info = new Map();
  for (const r of withLogin) {
    const n = counts.get(idOf(r.owner)) ?? 0;
    if (n >= minProjects && n <= maxProjects) info.set(idOf(r.owner), { activeProjects: n, designation: r.designation ?? null });
  }
  return okSet(label, 'user', info, { truncated, unmapped: rows.length - withLogin.length });
}

/** Active-project counts for given users (no population read). */
export async function activeProjectSet(e, within, { label = 'Projects' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(WORKLOAD_ACCESS, user, deps))) return restrictedSet(label, `Requires one of: ${WORKLOAD_ACCESS.anyOf.join(', ')}.`);
  const ids = validIds(within);
  const counts = ids.length ? await deps.countActiveProjects(ids) : new Map();
  const info = new Map();
  for (const id of ids) if ((counts.get(id) ?? 0) > 0) info.set(id, { activeProjects: counts.get(id) });
  return okSet(label, 'user', info);
}

/**
 * Assignees of tasks matching `clause`, only for viewers who see the org-wide task board (task.route
 * requireTaskListAccess). `within` narrows to those user ids so the set never scans the whole board.
 */
export async function taskAssigneeSet(e, { clause, within, label = 'Tasks' }) {
  const { user, deps } = env(e);
  const { orgWide } = await taskViewerScope(user, deps);
  if (!orgWide) return restrictedSet(label, 'Other people\'s tasks need tasks.read.');
  const w = within ? validIds(within) : null;
  if (w && !w.length) return okSet(label, 'user', new Map());
  const filter = await deps.buildAccessibleTaskFilter(user, { ...clause, ...(w ? { assignedTo: { $in: w } } : {}) });
  const { rows, truncated } = await cappedRows(deps.Task.find(filter).select('assignedTo title dueDate').sort({ dueDate: 1 }));
  const keep = w ? new Set(w) : null;
  const info = new Map();
  for (const t of rows) {
    for (const a of t.assignedTo || []) {
      const id = idOf(a);
      if (!id || (keep && !keep.has(id))) continue;
      const cur = info.get(id) || { tasks: 0, titles: [] };
      cur.tasks += 1;
      if (cur.titles.length < 3 && t.title) cur.titles.push(t.title);
      info.set(id, cur);
    }
  }
  return okSet(label, 'user', info, { truncated });
}

export const openTaskClause = () => ({ status: { $in: OPEN_TASK_STATUSES } });

// ─── Training ───────────────────────────────────────────────────────────────

/**
 * Training → Evaluation rows (active, non-resigned students) grouped per person, Student → User.
 * info: { courses: [{ course, status, completion, quizScore }] }.
 */
export async function trainingSet(e, { label = 'Training evaluation' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(COHORT_ACCESS, user, deps))) return restrictedSet(label, `Requires one of: ${COHORT_ACCESS.anyOf.join(', ')}.`);
  const data = await deps.getEvaluationData({});
  const byStudent = new Map();
  for (const r of data?.evaluations || []) {
    const sid = idOf(r.studentId);
    if (!sid) continue;
    const cur = byStudent.get(sid) || { courses: [] };
    cur.courses.push({
      course: r.courseName ?? null,
      status: r.displayStatus ?? null,
      completion: r.completionRate ?? 0,
      quizScore: r.quizScore ?? null,
    });
    byStudent.set(sid, cur);
  }
  const bySet = okSet(label, 'student', byStudent);
  const mapped = mapSet(bySet, await studentsToUsers([...byStudent.keys()], deps), 'user',
    (a, b) => ({ courses: [...a.courses, ...b.courses] }));
  return mapped;
}

/** Narrow an ok set's info with a predicate (label changes to say what it now holds). */
export function filterSet(set, predicate, label = set.label) {
  if (set.status !== 'ok') return set;
  const info = new Map();
  for (const [id, v] of set.info) {
    const out = predicate(v, id);
    if (out) info.set(id, out === true ? v : out);
  }
  return okSet(label, set.kind, info, {
    truncated: set.truncated, unmapped: set.unmapped, partialScope: set.partialScope, notes: set.notes,
  });
}

// ─── Hiring ─────────────────────────────────────────────────────────────────

const OWN_JOBS = 'Only rows on jobs you created or that you created yourself (page visibility).';

/** Placements matching `clause`, keyed by candidate (Employee id). */
export async function placementSet(e, { clause = {}, label = 'Placements' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(PLACEMENTS_ACCESS, user, deps))) return restrictedSet(label);
  const vis = visibilityToMongo(await deps.buildPlacementVisibilityClause(user));
  if (vis === null) return okSet(label, 'employee', new Map(), { partialScope: OWN_JOBS });
  const { rows, truncated } = await cappedRows(deps.Placement.find({ $and: [vis, { candidate: { $ne: null } }, clause] })
    .select('candidate status preBoardingStatus joiningDate joinedAt enteredOnboardingAt backgroundVerification.status backgroundVerification.completedAt')
    .sort({ joiningDate: 1 }));
  const info = new Map();
  for (const p of rows) {
    const id = idOf(p.candidate);
    if (info.has(id)) continue;
    info.set(id, {
      placementStatus: p.status ?? null,
      preBoardingStatus: p.preBoardingStatus ?? null,
      joiningDate: istDayOf(p.joiningDate),
      joinedAt: istDayOf(p.joinedAt),
      bgvStatus: p.backgroundVerification?.status ?? null,
      bgvCompletedAt: istDayOf(p.backgroundVerification?.completedAt),
    });
  }
  return okSet(label, 'employee', info, { truncated, partialScope: Object.keys(vis).length ? OWN_JOBS : null });
}

/** Offers matching `clause`, keyed by candidate (Employee id) or by job application id. */
export async function offerSet(e, { clause = {}, key = 'employee', label = 'Offers' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(OFFERS_ACCESS, user, deps))) return restrictedSet(label);
  const vis = visibilityToMongo(await deps.buildOfferVisibilityClause(user));
  if (vis === null) return okSet(label, key, new Map(), { partialScope: OWN_JOBS });
  const { rows, truncated } = await cappedRows(deps.Offer.find({ $and: [vis, clause] })
    .select('candidate jobApplication status acceptedAt joiningDate').sort({ createdAt: -1 }));
  const info = new Map();
  let unmapped = 0;
  for (const o of rows) {
    const id = idOf(key === 'application' ? o.jobApplication : o.candidate);
    if (!id) { unmapped += 1; continue; }
    if (!info.has(id)) {
      info.set(id, { offerStatus: o.status ?? null, acceptedAt: istDayOf(o.acceptedAt), joiningDate: istDayOf(o.joiningDate) });
    }
  }
  return okSet(label, key, info, { truncated, unmapped, partialScope: Object.keys(vis).length ? OWN_JOBS : null });
}

const OWN_INTERVIEWS = 'Only interviews you created, host, recruit for or are invited to (page visibility).';

/** ATS interviews (Meeting) matching `clause`, keyed by application id or candidate Employee id. */
export async function interviewSet(e, { clause = {}, key = 'application', label = 'Interviews' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(INTERVIEWS_ACCESS, user, deps))) return restrictedSet(label, 'Requires interviews.read.');
  const { filter } = await deps.meetingScope(user, 'read');
  const { rows, truncated } = await cappedRows(deps.Meeting.find({ $and: [filter, clause] })
    .select('applicationId candidateId candidate.id jobPosition scheduledAt interviewResult status').sort({ scheduledAt: -1 }));
  const info = new Map();
  let unmapped = 0;
  for (const m of rows) {
    // candidateId is the verified Employee link; candidate.id is free text (may be a mock/external id).
    const candidate = idOf(m.candidateId) ?? (m.candidate?.id ? String(m.candidate.id) : null);
    const id = key === 'application' ? idOf(m.applicationId) : candidate;
    if (!id) { unmapped += 1; continue; }
    if (!info.has(id)) {
      info.set(id, { interviewOn: istDayOf(m.scheduledAt), jobPosition: m.jobPosition ?? null, result: m.interviewResult ?? null });
    }
  }
  return okSet(label, key, info, {
    truncated, unmapped, partialScope: Object.keys(filter || {}).length ? OWN_INTERVIEWS : null,
  });
}

/**
 * People in a non-cancelled interview panel (recruiter, panel agents, hosts, invitees) or internal meeting
 * (organiser, hosts, invitees) on one IST day. Invite emails with no DharwinOne login are counted as
 * unmapped (external guests).
 */
export async function meetingParticipantSet(e, { day, label = 'Interviews and meetings' }) {
  const { user, deps } = env(e);
  const { from, to } = istBounds(day);
  const when = { scheduledAt: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } };
  const canInterviews = await allowed(INTERVIEWS_ACCESS, user, deps);
  const [ivScope, imScope] = await Promise.all([
    canInterviews ? deps.meetingScope(user, 'read') : null,
    deps.internalMeetingScope(user, 'read'),
  ]);
  const none = { rows: [], truncated: false };
  const [iv, im] = await Promise.all([
    ivScope ? cappedRows(deps.Meeting.find({ $and: [ivScope.filter, when] })
      .select('title scheduledAt recruiter.id agents.id hosts.email emailInvites')) : none,
    cappedRows(deps.InternalMeeting.find({ $and: [imScope.filter, when] })
      .select('title scheduledAt createdBy hosts.email emailInvites')),
  ]);
  const meetings = [
    ...iv.rows.map((m) => ({ m, kind: 'interview', ids: [m.recruiter?.id, ...(m.agents || []).map((a) => a?.id)] })),
    ...im.rows.map((m) => ({ m, kind: 'meeting', ids: [idOf(m.createdBy)] })),
  ];
  const emails = meetings.flatMap(({ m }) => [...(m.hosts || []).map((h) => h?.email), ...(m.emailInvites || [])]).filter(Boolean);
  const byEmail = await emailsToUsers(emails, deps);
  const info = new Map();
  for (const { m, kind, ids } of meetings) {
    const who = new Set(ids.filter(Boolean).map(String));
    for (const addr of [...(m.hosts || []).map((h) => h?.email), ...(m.emailInvites || [])]) {
      const uid = addr && byEmail.map.get(String(addr).trim().toLowerCase());
      if (uid) who.add(uid);
    }
    for (const uid of who) {
      const cur = info.get(uid) || { meetings: 0, titles: [] };
      cur.meetings += 1;
      if (cur.titles.length < 3) cur.titles.push(`${m.title ?? kind} (${kind})`);
      info.set(uid, cur);
    }
  }
  const notes = [];
  if (!canInterviews) notes.push('Interviews are not included (they need interviews.read) — internal meetings only.');
  const ownIv = ivScope && Object.keys(ivScope.filter || {}).length;
  const ownIm = Object.keys(imScope.filter || {}).length;
  return okSet(label, 'user', info, {
    truncated: iv.truncated || im.truncated,
    unmapped: byEmail.unmapped.length,
    partialScope: ownIv || ownIm ? 'Only meetings you created, host or are invited to (page visibility).' : null,
    notes,
  });
}

// ─── Attendance / leave ─────────────────────────────────────────────────────

/** Approved leave covering one day (LeaveRequest.dates are UTC-midnight day keys), Student → User. */
export async function leaveSet(e, { day, label = 'Approved leave' }) {
  const { user, deps } = env(e);
  const { filter: scope, scope: scopeKind } = await deps.buildLeaveRequestScopeFilter(user);
  if (scope === null) {
    return okSet(label, 'user', new Map(), { partialScope: 'You have no Student profile, so no leave rows are visible.' });
  }
  const { rows, truncated } = await cappedRows(deps.LeaveRequest.find({
    $and: [scope, { status: 'approved' }, leaveDatesWindowClause(dayKeys({ from: day, to: day }))],
  }).select('student leaveType'));
  const info = new Map();
  for (const r of rows) info.set(idOf(r.student), { leaveType: r.leaveType ?? null });
  const mapped = mapSet(okSet(label, 'student', info, { truncated }), await studentsToUsers([...info.keys()], deps), 'user');
  if (scopeKind !== 'all') mapped.partialScope = 'Only your own leave requests are visible to you.';
  return mapped;
}

/**
 * Employees marked Absent on one day by get_attendance_summary (no punch, not on leave / holiday /
 * week-off). Rows carry the employee code and email, mapped to the login.
 */
export async function absentSet(e, { day, label = 'Attendance' }) {
  const res = await e.deps.runTool('get_attendance_summary', { window: { from: day, to: day }, status: 'Absent' }, e.ctx, { timeoutMs: 8000 });
  if (res.status !== 'ok' || res.result?.error) return composedFailure(label, res);
  if (res.result?.futureDate) return notCapturedSet(label, res.result.note);
  const rows = res.result?.employees || [];
  const byCode = await employeeCodesToUsers(rows.map((r) => r.employeeId).filter(Boolean), e.deps);
  const needEmail = rows.filter((r) => !byCode.map.has(String(r.employeeId)) && r.email);
  const byEmail = await emailsToUsers(needEmail.map((r) => r.email), e.deps);
  const info = new Map();
  let unmapped = 0;
  for (const r of rows) {
    const uid = byCode.map.get(String(r.employeeId)) || byEmail.map.get(String(r.email || '').trim().toLowerCase());
    if (!uid) { unmapped += 1; continue; }
    info.set(uid, { attendance: r.status ?? 'Absent' });
  }
  return okSet(label, 'user', info, { unmapped });
}

// ─── Org chart / documents / applications ───────────────────────────────────

/** Employee ids placed in an org-chart department node; `unassigned` = on the chart but in no node. */
export async function chartSet(e, { label = 'Org chart' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed({ anyOf: [...ORG_READ_PERMISSIONS] }, user, deps))) {
    return restrictedSet(label, `Requires one of: ${ORG_READ_PERMISSIONS.join(', ')}.`);
  }
  const tree = await deps.buildTree(user);
  const info = new Map();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      for (const emp of n.employees || []) info.set(String(emp.id), { node: n.name ?? null });
      walk(n.children);
    }
  };
  walk(tree?.roots);
  const set = okSet(label, 'employee', info);
  set.unassigned = new Set((tree?.unassigned || []).map((x) => String(x.id)));
  return set;
}

/** Profiles among `within` whose paperwork is complete (hiring PAPERWORK_COMPLETE_MATCH). */
export async function paperworkCompleteSet(e, within, { label = 'Employee documents' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed(DOCUMENTS_ACCESS, user, deps)) || !canViewOthersDocuments(user)) return restrictedSet(label);
  const ids = validIds(within);
  const { rows, truncated } = ids.length
    ? await cappedRows(deps.Employee.find({ _id: { $in: ids }, ...PAPERWORK_COMPLETE_MATCH }).select('_id'))
    : { rows: [], truncated: false };
  return okSet(label, 'employee', new Map(rows.map((r) => [idOf(r), {}])), { truncated });
}

const isEmptyScope = (q) => Array.isArray(q?._id?.$in) && q._id.$in.length === 0;

/** Applications in the Applications-page scope (buildApplicantQuery) matching `clause`. */
export async function applicationSet(e, { filter = {}, clause = {}, key = 'application', sort = { createdAt: -1 }, label = 'Applications' } = {}) {
  const { user, deps } = env(e);
  if (!(await allowed({ anyOf: [APPLICATIONS_PAGE_PERMISSION] }, user, deps))) {
    return restrictedSet(label, `Requires ${APPLICATIONS_PAGE_PERMISSION}.`);
  }
  const { query } = await deps.buildApplicantQuery({ excludeInternal: true, ...filter }, user);
  if (isEmptyScope(query)) return okSet(label, key, new Map());
  const { rows, truncated } = await cappedRows(deps.JobApplication.find({ $and: [query, clause] })
    .select('candidate job status statusChangedAt updatedAt createdAt').sort(sort));
  const info = new Map();
  for (const a of rows) {
    const id = idOf(key === 'employee' ? a.candidate : a);
    if (!id || info.has(id)) continue;
    info.set(id, {
      applicationId: idOf(a), candidate: idOf(a.candidate), job: idOf(a.job), status: a.status ?? null,
      statusChangedAt: a.statusChangedAt ?? null, updatedAt: a.updatedAt ?? null,
    });
  }
  return okSet(label, key, info, { truncated });
}
