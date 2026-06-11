import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';
import StudentEssayAttempt from '../models/studentEssayAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';

export const AT_RISK_STALE_DAYS = 14;

const idStr = (v) => (v?._id?.toString?.() ?? v?.toString?.() ?? null);
const pairKey = (sid, mid) => `${sid}\u001f${mid}`;

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
    const entry = essayByKey.get(k) || { tries: 0, sum: 0 };
    entry.tries += 1;
    entry.sum += a.score?.percentage ?? 0;
    essayByKey.set(k, entry);
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
  for (const k of progressByKey.keys()) pairs.add(k);

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
      essayScore: essay && essay.tries > 0 ? Math.round(essay.sum / essay.tries) : null,
      essayTries: essay?.tries ?? 0,
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

const parseEvaluationQuery = (query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const rawLimit = parseInt(query.limit, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, rawLimit) : 0;
  return {
    courseId: query.courseId ? String(query.courseId) : null,
    positionId: query.positionId ? String(query.positionId) : null,
    categoryId: query.categoryId ? String(query.categoryId) : null,
    status: query.status ? String(query.status) : null,
    q: (query.q || '').trim() || null,
    atRiskOnly: query.atRisk === 'true' || query.atRisk === '1',
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
      status: { $in: ['graded', 'reviewed'] },
    })
      .select('student module score.percentage')
      .lean(),
  ]);

  const activeStudentIds = new Set(students.map((s) => s._id.toString()));

  const studentMetaById = new Map();
  for (const s of students) {
    studentMetaById.set(s._id.toString(), {
      name: s.user?.name,
      email: s.user?.email,
      positionId: idStr(s.position),
      positionName: s.position?.name ?? null,
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

  const result = { summary, evaluations: filtered };

  if (filters.limit > 0) {
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / filters.limit));
    const start = (filters.page - 1) * filters.limit;
    result.evaluations = filtered.slice(start, start + filters.limit);
    result.meta = {
      total,
      page: filters.page,
      limit: filters.limit,
      totalPages,
    };
  }

  return result;
};

/**
 * Mutually exclusive status counts for all active student–module pairs.
 * Includes module roster assignments without a progress record (same as Evaluation).
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
  for (const k of progressByKey.keys()) pairs.add(k);

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
  computeAtRisk,
  computeEnrollmentStatusBreakdown,
  AT_RISK_STALE_DAYS,
};
