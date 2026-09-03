import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';
import StudentEssayAttempt from '../models/studentEssayAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import Employee from '../models/employee.model.js';

export const AT_RISK_STALE_DAYS = 14;

const idStr = (v) => (v?._id?.toString?.() ?? v?.toString?.() ?? null);
const pairKey = (sid, mid) => `${sid}\u001f${mid}`;

const startOfToday = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
};

/** Same resigned rule as student.service excludeResignedEmployed and employee list "current". */
export const isEmployeeResigned = (employee, todayStart = startOfToday()) => {
  if (!employee) return false;
  if (employee.referralPipelineStatus === 'resigned') return true;
  if (!employee.resignDate) return false;
  const rd = new Date(employee.resignDate);
  rd.setHours(0, 0, 0, 0);
  return rd <= todayStart;
};

/** Student.position first; fall back to Employee.position, designation, referralJobTitle. */
export const resolveStudentPositionMeta = (student, employee) => {
  const studentPositionId = idStr(student?.position);
  const studentPositionName =
    typeof student?.position === 'object' && student.position?.name ? student.position.name : null;
  if (studentPositionName) {
    return { positionId: studentPositionId, positionName: studentPositionName };
  }

  const employeePositionId = idStr(employee?.position);
  const employeePositionName =
    typeof employee?.position === 'object' && employee.position?.name ? employee.position.name : null;
  if (employeePositionName) {
    return { positionId: employeePositionId, positionName: employeePositionName };
  }

  for (const title of [employee?.designation, employee?.referralJobTitle]) {
    const trimmed = String(title ?? '').trim();
    if (trimmed) return { positionId: null, positionName: trimmed };
  }

  return { positionId: studentPositionId, positionName: null };
};

/**
 * Unified display status for a student–course evaluation row.
 * @returns {'Completed'|'In Progress'|'Not Started'}
 */
export const deriveCourseDisplayStatus = (row) => {
  const rate = row.completionRate ?? 0;
  const dbStatus = row.status;
  if (dbStatus === 'completed' || row.certificateIssued) return 'Completed';
  if (rate >= 100 && row.completedAt) return 'Completed';
  if (rate > 0 || dbStatus === 'in-progress' || row.startedAt) return 'In Progress';
  return 'Not Started';
};

/**
 * @param {Object} row
 * @param {number} [now]
 * @returns {{ atRisk: boolean, atRiskReason: string|null }}
 */
export const computeAtRisk = (row, now = Date.now()) => {
  const status = row.displayStatus ?? deriveCourseDisplayStatus(row);
  if (status === 'Completed') return { atRisk: false, atRiskReason: null };

  const msDay = 86400000;
  const enrolledAt = row.enrolledAt ? new Date(row.enrolledAt).getTime() : null;
  const lastAccessedAt = row.lastAccessedAt ? new Date(row.lastAccessedAt).getTime() : null;

  if (status === 'Not Started' && enrolledAt && (now - enrolledAt) / msDay >= AT_RISK_STALE_DAYS) {
    return { atRisk: true, atRiskReason: 'not_started' };
  }
  if (status === 'In Progress') {
    if (lastAccessedAt && (now - lastAccessedAt) / msDay >= AT_RISK_STALE_DAYS) {
      return { atRisk: true, atRiskReason: 'stale' };
    }
    if (!lastAccessedAt && enrolledAt && (now - enrolledAt) / msDay >= AT_RISK_STALE_DAYS) {
      return { atRisk: true, atRiskReason: 'no_activity' };
    }
  }
  return { atRisk: false, atRiskReason: null };
};

const applyEvaluationFilters = (evaluations, filters) => {
  let rows = evaluations;
  if (filters.studentId) rows = rows.filter((r) => r.studentId === filters.studentId);
  if (filters.courseId) rows = rows.filter((r) => r.courseId === filters.courseId);
  if (filters.positionId) rows = rows.filter((r) => r.positionId === filters.positionId);
  if (filters.categoryId) rows = rows.filter((r) => (r.categoryIds || []).includes(filters.categoryId));
  if (filters.status) rows = rows.filter((r) => r.displayStatus === filters.status);
  if (filters.atRiskOnly) rows = rows.filter((r) => r.atRisk);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        (r.studentName && r.studentName.toLowerCase().includes(q)) ||
        (r.courseName && r.courseName.toLowerCase().includes(q))
    );
  }
  return rows;
};

/** Scope filters only — used before aggregation so row counts stay correct. */
export const applyStructuralEvaluationFilters = (evaluations, filters) =>
  applyEvaluationFilters(evaluations, { ...filters, status: null, atRiskOnly: false, q: null });

/**
 * Visibility filters on aggregated rows. Aggregates are built from structural scope only.
 */
export const filterAggregatedEvaluationRows = (aggregated, structuralEvaluations, filters, view) => {
  let rows = aggregated;

  if (filters.atRiskOnly) {
    rows = rows.filter((row) => row.atRiskCount > 0);
  }

  if (filters.status) {
    if (view === 'student') {
      rows = rows.filter((row) => row.overallStatus === filters.status);
    } else {
      const courseIds = new Set(
        structuralEvaluations
          .filter((r) => r.displayStatus === filters.status)
          .map((r) => r.courseId)
          .filter(Boolean)
      );
      rows = rows.filter((row) => courseIds.has(row.courseId));
    }
  }

  if (filters.q) {
    const q = filters.q.toLowerCase();
    const matching = structuralEvaluations.filter(
      (r) =>
        (r.studentName && r.studentName.toLowerCase().includes(q)) ||
        (r.courseName && r.courseName.toLowerCase().includes(q))
    );
    if (view === 'student') {
      const studentIds = new Set(matching.map((r) => r.studentId).filter(Boolean));
      rows = rows.filter((row) => studentIds.has(row.studentId));
    } else {
      const courseIds = new Set(matching.map((r) => r.courseId).filter(Boolean));
      rows = rows.filter((row) => courseIds.has(row.courseId));
    }
  }

  return rows;
};

/** Mirrors frontend deriveOverallStatus — keep in sync with evaluation-utils.ts */
export const deriveOverallStatus = (courses) => {
  if (!courses?.length) return 'Not Started';
  const statuses = courses.map((c) => c.displayStatus ?? deriveCourseDisplayStatus(c));
  if (statuses.every((s) => s === 'Completed')) return 'Completed';
  if (statuses.some((s) => s === 'In Progress' || s === 'Completed')) return 'In Progress';
  return 'Not Started';
};

export const aggregateStudentRows = (evaluations) => {
  const map = new Map();
  for (const e of evaluations) {
    if (!e.studentId) continue;
    const existing = map.get(e.studentId) || [];
    existing.push(e);
    map.set(e.studentId, existing);
  }

  const rows = [];
  for (const [studentId, courses] of map.entries()) {
    const avgCompletion = courses.reduce((s, c) => s + (c.completionRate ?? 0), 0) / courses.length;
    const scores = courses.map((c) => c.quizScore).filter((v) => v != null);
    const avgQuiz = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    rows.push({
      studentId,
      studentName: courses[0].studentName,
      positionName: courses[0].positionName ?? null,
      coursesAssigned: courses.length,
      avgCompletion: Math.round(avgCompletion),
      overallStatus: deriveOverallStatus(courses),
      completedCount: courses.filter((c) => deriveCourseDisplayStatus(c) === 'Completed').length,
      avgQuizScore: avgQuiz,
      atRiskCount: courses.filter((c) => c.atRisk).length,
    });
  }
  return rows;
};

export const aggregateCourseRows = (evaluations) => {
  const map = new Map();
  for (const e of evaluations) {
    if (!e.courseId) continue;
    const existing = map.get(e.courseId) || [];
    existing.push(e);
    map.set(e.courseId, existing);
  }

  const rows = [];
  for (const [courseId, rowsForCourse] of map.entries()) {
    const avgCompletion =
      rowsForCourse.reduce((s, c) => s + (c.completionRate ?? 0), 0) / rowsForCourse.length;
    const categories = new Set();
    for (const r of rowsForCourse) for (const n of r.categoryNames || []) categories.add(n);
    rows.push({
      courseId,
      courseName: rowsForCourse[0].courseName,
      categoryNames: [...categories],
      studentsAssigned: rowsForCourse.length,
      avgCompletion: Math.round(avgCompletion),
      completedCount: rowsForCourse.filter((c) => deriveCourseDisplayStatus(c) === 'Completed').length,
      atRiskCount: rowsForCourse.filter((c) => c.atRisk).length,
    });
  }
  return rows;
};

const STUDENT_SORT_FIELDS = {
  student: 'studentName',
  studentName: 'studentName',
  position: 'positionName',
  courses: 'coursesAssigned',
  avgCompletion: 'avgCompletion',
  status: 'overallStatus',
  avgQuiz: 'avgQuizScore',
};

const COURSE_SORT_FIELDS = {
  course: 'courseName',
  courseName: 'courseName',
  categories: 'categoryNames',
  students: 'studentsAssigned',
  avgCompletion: 'avgCompletion',
  atRisk: 'atRiskCount',
};

const compareValues = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (Array.isArray(a) && Array.isArray(b)) return a.join(', ').localeCompare(b.join(', '));
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
};

export const sortEvaluationViewRows = (rows, view, sortBy, sortOrder = 'asc') => {
  const fieldMap = view === 'course' ? COURSE_SORT_FIELDS : STUDENT_SORT_FIELDS;
  const field = fieldMap[sortBy] || (view === 'course' ? 'courseName' : 'studentName');
  const dir = sortOrder === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => compareValues(left[field], right[field]) * dir);
};

/**
 * @param {Array} items
 * @param {number} page 1-based
 * @param {number} limit
 */
export const paginateList = (items, page, limit) => {
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const safePage = totalPages === 0 ? 1 : Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    meta: {
      total,
      page: safePage,
      limit,
      totalPages,
    },
  };
};

const buildSummary = (evaluations) => {
  const studentIdSet = new Set();
  const courseIdSet = new Set();
  let atRiskCount = 0;
  let completedPairs = 0;
  let inProgressPairs = 0;
  let notStartedPairs = 0;

  for (const row of evaluations) {
    if (row.studentId) studentIdSet.add(row.studentId);
    if (row.courseId) courseIdSet.add(row.courseId);
    if (row.atRisk) atRiskCount += 1;
    if (row.displayStatus === 'Completed') completedPairs += 1;
    else if (row.displayStatus === 'In Progress') inProgressPairs += 1;
    else notStartedPairs += 1;
  }

  return {
    totalCourses: courseIdSet.size,
    totalStudentsEnrolled: studentIdSet.size,
    atRiskCount,
    completedPairs,
    inProgressPairs,
    notStartedPairs,
  };
};

/**
 * Pure aggregation core (no DB) so it can be unit tested.
 */
export const buildEvaluation = ({
  modules = [],
  progressList = [],
  quizAttempts = [],
  essayAttempts = [],
  studentMetaById = new Map(),
  activeStudentIds = null,
}) => {
  const moduleNameById = new Map();
  const moduleMetaById = new Map();

  for (const m of modules) {
    const mid = idStr(m._id);
    if (!mid) continue;
    moduleNameById.set(mid, m.moduleName ?? '—');
    const categoryIds = (m.categories || []).map((c) => idStr(c)).filter(Boolean);
    const categoryNames = (m.categories || [])
      .map((c) => (typeof c === 'object' && c?.name ? c.name : null))
      .filter(Boolean);
    moduleMetaById.set(mid, { categoryIds, categoryNames });
  }

  const progressByKey = new Map();
  for (const p of progressList) {
    const sid = idStr(p.student);
    const mid = idStr(p.module);
    if (!sid || !mid) continue;
    progressByKey.set(pairKey(sid, mid), p);
    if (!moduleNameById.has(mid)) moduleNameById.set(mid, p.module?.moduleName ?? '—');
    const name = p.student?.user?.name ?? (p.student?.user?.email ? `(${p.student.user.email})` : null);
    if (name && !studentMetaById.has(sid)) {
      studentMetaById.set(sid, {
        name: p.student.user?.name,
        email: p.student.user?.email,
        positionId: idStr(p.student?.position),
        positionName: p.student?.position?.name ?? null,
      });
    }
  }

  const quizByKey = new Map();
  for (const a of quizAttempts) {
    const sid = idStr(a.student);
    const mid = idStr(a.module);
    if (!sid || !mid) continue;
    const k = pairKey(sid, mid);
    const entry = quizByKey.get(k) || { tries: 0, sum: 0, best: 0 };
    const pct = a.score?.percentage ?? 0;
    entry.tries += 1;
    entry.sum += pct;
    entry.best = Math.max(entry.best, pct);
    quizByKey.set(k, entry);
  }

  const essayByKey = new Map();
  for (const a of essayAttempts) {
    const sid = idStr(a.student);
    const mid = idStr(a.module);
    if (!sid || !mid) continue;
    const k = pairKey(sid, mid);
    const entry = essayByKey.get(k) || { tries: 0, sum: 0, graded: 0, pending: 0 };
    entry.tries += 1;
    const status = a.status === 'reviewed' ? 'graded' : a.status;
    const pct = a.score?.percentage;
    const hasPct = typeof pct === 'number';
    if ((status === 'graded' || !status) && hasPct) {
      entry.sum += pct;
      entry.graded += 1;
    } else if (status === 'submitted' || (status === 'graded' && !hasPct)) {
      entry.pending += 1;
    }
    essayByKey.set(k, entry);
  }

  // Assigned courses = module roster only (same source as My Courses / queryStudentCourses).
  const pairs = new Set();
  for (const m of modules) {
    const mid = idStr(m._id);
    if (!mid) continue;
    for (const sid of m.students || []) {
      const s = idStr(sid);
      if (s) pairs.add(pairKey(s, mid));
    }
  }

  const resolveName = (sid, progress) => {
    const fromMap = studentMetaById.get(sid);
    if (fromMap?.name) return fromMap.name;
    if (fromMap?.email) return `(${fromMap.email})`;
    const u = progress?.student?.user;
    if (u?.name) return u.name;
    if (u?.email) return `(${u.email})`;
    return null;
  };

  const evaluations = [];

  for (const k of pairs) {
    const sep = k.indexOf('\u001f');
    const studentId = sep >= 0 ? k.slice(0, sep) : k.split('_')[0];
    const moduleId = sep >= 0 ? k.slice(sep + 1) : k.split('_')[1];
    if (activeStudentIds && !activeStudentIds.has(studentId)) continue;

    const progress = progressByKey.get(k) || null;
    const studentName = resolveName(studentId, progress);
    if (!studentName) continue;

    const meta = studentMetaById.get(studentId) || {};
    const modMeta = moduleMetaById.get(moduleId) || { categoryIds: [], categoryNames: [] };
    const quiz = quizByKey.get(k);
    const essay = essayByKey.get(k);

    const row = {
      studentId: studentId ?? null,
      studentName,
      courseId: moduleId ?? null,
      courseName: moduleNameById.get(moduleId) ?? '—',
      completionRate: progress?.progress?.percentage ?? 0,
      completedAt: progress?.completedAt ?? null,
      enrolledAt: progress?.enrolledAt ?? null,
      startedAt: progress?.startedAt ?? null,
      lastAccessedAt: progress?.progress?.lastAccessedAt ?? null,
      quizScore: quiz && quiz.tries > 0 ? Math.round(quiz.sum / quiz.tries) : null,
      quizScoreBest: quiz && quiz.tries > 0 ? Math.round(quiz.best) : null,
      quizTries: quiz?.tries ?? 0,
      essayScore: essay && essay.graded > 0 ? Math.round(essay.sum / essay.graded) : null,
      essayTries: essay?.tries ?? 0,
      essayPending: essay?.pending ?? 0,
      certificateIssued: Boolean(progress?.certificate?.issued),
      positionId: meta.positionId ?? idStr(progress?.student?.position) ?? null,
      positionName: meta.positionName ?? progress?.student?.position?.name ?? null,
      categoryIds: modMeta.categoryIds ?? [],
      categoryNames: modMeta.categoryNames ?? [],
      status: progress?.status ?? 'enrolled',
    };

    row.displayStatus = deriveCourseDisplayStatus(row);
    const risk = computeAtRisk(row);
    row.atRisk = risk.atRisk;
    row.atRiskReason = risk.atRiskReason;

    evaluations.push(row);
  }

  return {
    summary: buildSummary(evaluations),
    evaluations,
  };
};

const parseAtRiskQuery = (raw) => {
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  return false;
};

const parseEvaluationQuery = (query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const hasPagination = query.page != null || query.limit != null;
  const rawLimit = parseInt(query.limit, 10);
  const limit =
    hasPagination && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(500, rawLimit)
      : hasPagination
        ? 50
        : 0;
  const view = query.view === 'course' ? 'course' : 'student';
  const sortOrder = query.sortOrder === 'desc' ? 'desc' : 'asc';
  const sortBy = query.sortBy ? String(query.sortBy) : null;
  const courseRaw = query.courseId ?? query.course;
  return {
    courseId: courseRaw ? String(courseRaw) : null,
    studentId: query.studentId ? String(query.studentId) : null,
    positionId: query.positionId ? String(query.positionId) : null,
    categoryId: query.categoryId ? String(query.categoryId) : null,
    status: query.status ? String(query.status) : null,
    q: (query.q || '').trim() || null,
    atRiskOnly: parseAtRiskQuery(query.atRisk),
    view,
    sortBy,
    sortOrder,
    page,
    limit,
  };
};

/**
 * @param {Object} [query]
 * @returns {Promise<{ summary: Object, evaluations: Array, meta?: Object }>}
 */
const getEvaluationData = async (query = {}) => {
  const filters = parseEvaluationQuery(query);

  const [modules, progressList] = await Promise.all([
    TrainingModule.find()
      .select('moduleName students categories positions')
      .populate({ path: 'categories', select: 'name' })
      .lean(),
    StudentCourseProgress.find()
      .populate({
        path: 'student',
        select: 'user position status',
        populate: [
          { path: 'user', select: 'name email' },
          { path: 'position', select: 'name' },
        ],
      })
      .populate({ path: 'module', select: 'moduleName categories' })
      .lean(),
  ]);

  const studentIdSet = new Set();
  for (const m of modules) for (const sid of m.students || []) studentIdSet.add(sid.toString());
  for (const p of progressList) if (p.student?._id) studentIdSet.add(p.student._id.toString());

  const moduleIdSet = new Set(modules.map((m) => m._id.toString()));

  const [students, quizAttempts, essayAttempts] = await Promise.all([
    Student.find({ _id: { $in: [...studentIdSet] }, status: 'active' })
      .select('user position status')
      .populate({ path: 'user', select: 'name email' })
      .populate({ path: 'position', select: 'name' })
      .lean(),
    StudentQuizAttempt.find({
      student: { $in: [...studentIdSet] },
      module: { $in: [...moduleIdSet] },
      status: 'graded',
    })
      .select('student module score.percentage')
      .lean(),
    StudentEssayAttempt.find({
      student: { $in: [...studentIdSet] },
      module: { $in: [...moduleIdSet] },
    })
      .select('student module score.percentage status')
      .lean(),
  ]);

  const ownerIds = students.map((s) => s.user?._id ?? s.user).filter(Boolean);
  const employees = ownerIds.length
    ? await Employee.find({ owner: { $in: ownerIds } })
        .select('owner position designation referralJobTitle resignDate referralPipelineStatus')
        .populate({ path: 'position', select: 'name' })
        .lean()
    : [];

  const employeeByOwner = new Map(employees.map((e) => [String(e.owner), e]));
  const todayStart = startOfToday();

  const activeStudents = students.filter((s) => {
    const ownerId = String(s.user?._id ?? s.user ?? '');
    if (!ownerId) return true;
    return !isEmployeeResigned(employeeByOwner.get(ownerId), todayStart);
  });

  const activeStudentIds = new Set(activeStudents.map((s) => s._id.toString()));

  const studentMetaById = new Map();
  for (const s of activeStudents) {
    const ownerId = String(s.user?._id ?? s.user ?? '');
    const employee = ownerId ? employeeByOwner.get(ownerId) : null;
    const position = resolveStudentPositionMeta(s, employee);
    studentMetaById.set(s._id.toString(), {
      name: s.user?.name,
      email: s.user?.email,
      positionId: position.positionId,
      positionName: position.positionName,
    });
  }

  const built = buildEvaluation({
    modules,
    progressList,
    quizAttempts,
    essayAttempts,
    studentMetaById,
    activeStudentIds,
  });

  const filtered = applyEvaluationFilters(built.evaluations, filters);
  const summary = buildSummary(filtered);

  const structuralFiltered = applyStructuralEvaluationFilters(built.evaluations, filters);
  let aggregated =
    filters.view === 'course'
      ? aggregateCourseRows(structuralFiltered)
      : aggregateStudentRows(structuralFiltered);
  aggregated = filterAggregatedEvaluationRows(
    aggregated,
    structuralFiltered,
    filters,
    filters.view
  );
  const sorted = sortEvaluationViewRows(aggregated, filters.view, filters.sortBy, filters.sortOrder);

  if (filters.limit > 0) {
    const { items, meta } = paginateList(sorted, filters.page, filters.limit);
    const pageStudentIds = new Set(items.map((r) => r.studentId).filter(Boolean));
    const pageCourseIds = new Set(items.map((r) => r.courseId).filter(Boolean));
    const pageEvaluations = structuralFiltered.filter((row) =>
      filters.view === 'course' ? pageCourseIds.has(row.courseId) : pageStudentIds.has(row.studentId)
    );

    return {
      summary,
      rows: items,
      evaluations: pageEvaluations,
      meta,
    };
  }

  return {
    summary,
    rows: sorted,
    evaluations: filtered,
  };
};

/**
 * Mutually exclusive status counts for all active student–module pairs.
 * Includes module roster assignments without a progress record (same as My Courses).
 */
export const computeEnrollmentStatusBreakdown = ({
  modules = [],
  progressList = [],
  activeStudentIds = null,
}) => {
  const progressByKey = new Map();
  for (const p of progressList) {
    const sid = idStr(p.student);
    const mid = idStr(p.module);
    if (sid && mid) progressByKey.set(pairKey(sid, mid), p);
  }

  const pairs = new Set();
  for (const m of modules) {
    const mid = idStr(m._id);
    if (!mid) continue;
    for (const sid of m.students || []) {
      const s = idStr(sid);
      if (s) pairs.add(pairKey(s, mid));
    }
  }

  const activeSet =
    activeStudentIds instanceof Set
      ? activeStudentIds
      : activeStudentIds
        ? new Set([...activeStudentIds].map((id) => idStr(id)))
        : null;

  const counts = { notStarted: 0, inProgress: 0, completed: 0 };

  for (const k of pairs) {
    const sep = k.indexOf('\u001f');
    const studentId = sep >= 0 ? k.slice(0, sep) : k;
    if (activeSet && !activeSet.has(studentId)) continue;

    const progress = progressByKey.get(k) || null;
    const displayStatus = deriveCourseDisplayStatus({
      completionRate: progress?.progress?.percentage ?? 0,
      completedAt: progress?.completedAt ?? null,
      startedAt: progress?.startedAt ?? null,
      certificateIssued: Boolean(progress?.certificate?.issued),
      status: progress?.status ?? 'enrolled',
    });

    if (displayStatus === 'Completed') counts.completed += 1;
    else if (displayStatus === 'In Progress') counts.inProgress += 1;
    else counts.notStarted += 1;
  }

  return counts;
};

export default {
  getEvaluationData,
  buildEvaluation,
  deriveCourseDisplayStatus,
  deriveOverallStatus,
  aggregateStudentRows,
  aggregateCourseRows,
  sortEvaluationViewRows,
  paginateList,
  computeAtRisk,
  computeEnrollmentStatusBreakdown,
  isEmployeeResigned,
  resolveStudentPositionMeta,
  applyStructuralEvaluationFilters,
  filterAggregatedEvaluationRows,
  AT_RISK_STALE_DAYS,
};
