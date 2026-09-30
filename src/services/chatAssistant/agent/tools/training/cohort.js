import { allowed, pickByName, ROSTER_ACCESS } from './common.js';
import { dayWindowBounds } from '../employees/common.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';

const MAX_COURSES_PER_POSITION = 30;
const PROGRESS_STATUS = { not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed' };
export const OVERDUE_NOTE =
  'Training modules have no due date in DharwinOne, so "overdue" is not captured. atRisk (not started or no ' +
  'activity for 14+ days, the Evaluation page rule) is the closest signal.';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

function distinctBy(rows, key, name) {
  const seen = new Map();
  for (const r of rows) {
    const k = r[key] ?? `name:${lc(r[name])}`;
    if (r[name] && !seen.has(k)) seen.set(k, { id: r[key] ?? null, name: r[name] });
  }
  return [...seen.values()];
}

function scoreRange({ scoreBand, minScore, maxScore }) {
  if (scoreBand === 'gte90') return { min: 90, max: 100 };
  if (scoreBand === 'lt70') return { min: 0, max: 69 }; // quizScore is a rounded integer
  if (scoreBand === 'custom') return { min: minScore ?? 0, max: maxScore ?? 100 };
  return null;
}

function summarize(rows) {
  const students = new Set(rows.map((r) => r.studentId));
  const completed = rows.filter((r) => r.displayStatus === 'Completed').length;
  const inProgress = rows.filter((r) => r.displayStatus === 'In Progress').length;
  const scores = rows.map((r) => r.quizScore).filter((v) => v != null);
  return {
    assignments: rows.length,
    students: students.size,
    completed,
    inProgress,
    notStarted: rows.length - completed - inProgress,
    completionRate: pct(completed, rows.length),
    avgCompletion: rows.length ? Math.round(rows.reduce((s, r) => s + (r.completionRate ?? 0), 0) / rows.length) : null,
    avgQuizScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    withQuizScore: scores.length,
    atRisk: rows.filter((r) => r.atRisk).length,
  };
}

function cohortRow(r) {
  return {
    student: r.studentName ?? null,
    course: r.courseName ?? null,
    position: r.positionName ?? null,
    status: r.displayStatus ?? null,
    completion: r.completionRate ?? 0,
    quizScore: r.quizScore ?? null,
    lastAccessedAt: r.lastAccessedAt ?? null,
    enrolledAt: r.enrolledAt ?? null,
    atRisk: !!r.atRisk,
  };
}

/**
 * Employees mapped to the cohort's positions (Curriculum Setup roster) whose login has no Student
 * profile — they have no LMS data at all, so they are listed, never counted as 0%.
 * ponytail: one $in over the roster's employee ids; fine to a few thousand employees.
 */
async function employeesWithoutStudentProfile(rosterRows, limit, deps) {
  const byId = new Map();
  for (const row of rosterRows) for (const e of row.assignedEmployees || []) byId.set(String(e.id), e.name ?? null);
  if (!byId.size) return { total: 0, records: [] };
  const emps = await deps.Employee.find({ _id: { $in: [...byId.keys()] } }).select('owner employeeId').lean();
  const owners = emps.map((e) => e.owner).filter(Boolean);
  const students = owners.length ? await deps.Student.find({ user: { $in: owners } }).select('user').lean() : [];
  const hasStudent = new Set(students.map((s) => String(s.user)));
  const missing = emps
    .filter((e) => !e.owner || !hasStudent.has(String(e.owner)))
    .map((e) => ({ name: byId.get(String(e._id)) ?? null, employeeId: e.employeeId ?? null }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { total: missing.length, records: missing.slice(0, limit) };
}

/** Cohort mode: the Training → Evaluation page rows (getEvaluationData), narrowed in memory. */
export async function runCohort(args, user, deps) {
  const { course, position, progress, inactiveDays, overdue, limit = 20 } = args;
  const data = await deps.getEvaluationData({});
  let rows = data?.evaluations || [];
  const canRoster = await allowed(ROSTER_ACCESS, user);
  const roster = canRoster ? (await deps.getPositionRoster({}, {}))?.results || [] : null;

  let courseHit = null;
  if (course) {
    const pick = pickByName(distinctBy(rows, 'courseId', 'courseName'), course);
    if (pick.kind === 'notFound') {
      return { mode: 'cohort', notFound: 'course', searchedFor: course,
        note: 'No course by that name has anyone assigned on the Training Evaluation page.' };
    }
    if (pick.kind === 'ambiguous' || pick.items.length > 1) {
      return { mode: 'cohort', ambiguous: 'course', matches: pick.items.slice(0, 10).map((c) => c.name) };
    }
    [courseHit] = pick.items;
    rows = rows.filter((r) => r.courseId === courseHit.id);
  }

  let positionName = null;
  if (position) {
    const names = distinctBy(rows, 'positionId', 'positionName').map((p) => p.name);
    for (const r of roster || []) if (r.name) names.push(r.name);
    const unique = [...new Map(names.map((n) => [lc(n), n])).values()].map((name) => ({ name }));
    const pick = pickByName(unique, position);
    if (pick.kind === 'notFound') return { mode: 'cohort', notFound: 'position', searchedFor: position };
    if (pick.kind === 'ambiguous') {
      return { mode: 'cohort', ambiguous: 'position', matches: pick.items.slice(0, 10).map((p) => p.name) };
    }
    positionName = pick.items[0].name;
    rows = rows.filter((r) => lc(r.positionName) === lc(positionName));
  }

  const cohort = summarize(rows);
  let hits = rows;
  if (progress) hits = hits.filter((r) => r.displayStatus === PROGRESS_STATUS[progress]);
  const band = scoreRange(args);
  if (band) hits = hits.filter((r) => r.quizScore != null && r.quizScore >= band.min && r.quizScore <= band.max);
  let noActivityDate = null;
  if (inactiveDays) {
    // Whole IST days: no access on any of the last N days, today included (N=14 on 30 Sep → last
    // access on or before 16 Sep). Unfinished rows with no access or enrolment date at all (module
    // roster only, never opened) cannot be dated, so they are counted separately, not guessed.
    const today = dateStrInTz(new Date(deps.now()), DEFAULT_TIMEZONE);
    const cutoff = new Date(dayWindowBounds({ from: addDaysToDateStr(today, 1 - inactiveDays) }).from).getTime();
    const unfinished = hits.filter((r) => r.displayStatus !== 'Completed');
    noActivityDate = unfinished.filter((r) => (r.lastAccessedAt ?? r.enrolledAt) == null).length;
    hits = unfinished.filter((r) => {
      const ref = r.lastAccessedAt ?? r.enrolledAt;
      return ref != null && new Date(ref).getTime() < cutoff;
    });
  }
  hits = [...hits].sort((a, b) => (a.completionRate ?? 0) - (b.completionRate ?? 0)
    || String(a.studentName).localeCompare(String(b.studentName)));

  let withoutStudentProfile = null;
  if (roster) {
    let scoped = roster;
    if (positionName) scoped = scoped.filter((r) => lc(r.name) === lc(positionName));
    if (courseHit) scoped = scoped.filter((r) => (r.assignedModules || []).some((m) => String(m.id) === courseHit.id));
    withoutStudentProfile = await employeesWithoutStudentProfile(scoped, limit, deps);
  }

  return {
    mode: 'cohort',
    course: courseHit?.name ?? null,
    position: positionName,
    total: hits.length,
    students: new Set(hits.map((r) => r.studentId)).size,
    cohort,
    ...(progress ? { progress } : {}),
    ...(band ? { scoreRange: band, scoreSource: 'average graded quiz score (%)' } : {}),
    ...(inactiveDays ? {
      inactiveDays,
      ...(noActivityDate ? {
        noActivityDate,
        noActivityDateNote: `${noActivityDate} more unfinished assignment(s) were never opened and have no ` +
          'enrolment date, so how long they have been idle is unknown.',
      } : {}),
    } : {}),
    records: hits.slice(0, limit).map(cohortRow),
    ...(overdue ? { overdue: null, overdueNote: OVERDUE_NOTE } : {}),
    withoutStudentProfile,
    ...(roster ? {} : {
      withoutStudentProfileNote: 'Listing employees with no Student profile needs positions.read or employees.read.',
    }),
  };
}

/** Position → courses / folders map: the Curriculum Setup roster (getPositionRoster). */
export async function runPositionMap({ position, limit = 20 }, deps) {
  let rows = (await deps.getPositionRoster({}, {}))?.results || [];
  if (position) {
    const pick = pickByName(rows, position);
    if (pick.kind === 'notFound') return { mode: 'position_map', notFound: 'position', searchedFor: position };
    if (pick.kind === 'ambiguous') {
      return { mode: 'position_map', ambiguous: 'position', matches: pick.items.slice(0, 10).map((p) => p.name) };
    }
    rows = pick.items;
  }
  const moduleIds = [...new Set(rows.flatMap((r) => (r.assignedModules || []).map((m) => String(m.id))))];
  // Folders are the modules' categories; the roster keeps them internal, so read just that field.
  const mods = moduleIds.length
    ? await deps.TrainingModule.find({ _id: { $in: moduleIds } }).select('categories').populate('categories', 'name').lean()
    : [];
  const foldersByModule = new Map(mods.map((m) => [String(m._id), (m.categories || []).map((c) => c?.name).filter(Boolean)]));
  const records = rows.slice(0, limit).map((r) => {
    const courses = r.assignedModules || [];
    return {
      position: r.name ?? null,
      department: r.department || null,
      courses: courses.slice(0, MAX_COURSES_PER_POSITION).map((m) => m.name),
      courseCount: courses.length,
      folders: [...new Set(courses.flatMap((m) => foldersByModule.get(String(m.id)) || []))],
      employeeCount: r.employeeCount ?? 0,
      studentCount: r.studentCount ?? 0,
      ...(r.unlinked ? { unlinked: true } : {}),
    };
  });
  return { mode: 'position_map', total: rows.length, records };
}
