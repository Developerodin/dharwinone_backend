import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';

/**
 * Get evaluation summary and all student-course evaluations.
 * Summary: total courses (modules with at least one student), total enrollments.
 * Rows: one per (student, course) with completion rate, completion date, quiz score, quiz tries.
 * @returns {Promise<{ summary: { totalCourses: number, totalStudentsEnrolled: number }, evaluations: Array }>}
 */
const getEvaluationData = async () => {
  const progressList = await StudentCourseProgress.find()
    .populate({
      path: 'student',
      select: 'user',
      populate: { path: 'user', select: 'name email' },
    })
    .populate({ path: 'module', select: 'moduleName' })
    .lean();

  const moduleIds = [...new Set(progressList.map((p) => p.module?._id?.toString()).filter(Boolean))];
  const totalCourses = moduleIds.length;
  const totalStudentsEnrolled = progressList.length;

  const studentIds = [...new Set(progressList.map((p) => p.student?._id?.toString()).filter(Boolean))];
  const moduleIdsForQuiz = [...new Set(progressList.map((p) => p.module?._id?.toString()).filter(Boolean))];

  const quizAttempts = await StudentQuizAttempt.find({
    student: { $in: studentIds },
    module: { $in: moduleIdsForQuiz },
    status: 'graded',
  })
    .select('student module playlistItemId attemptNumber score.percentage')
    .lean();

  const quizByStudentModule = {};
  for (const a of quizAttempts) {
    const sid = a.student?.toString?.() ?? a.student;
    const mid = a.module?.toString?.() ?? a.module;
    const sk = `${sid}_${mid}`;
    if (!quizByStudentModule[sk]) {
      quizByStudentModule[sk] = { totalTries: 0, scores: [], bestScore: null };
    }
    quizByStudentModule[sk].totalTries += 1;
    const pct = a.score?.percentage ?? 0;
    quizByStudentModule[sk].scores.push(pct);
    if (quizByStudentModule[sk].bestScore == null || pct > quizByStudentModule[sk].bestScore) {
      quizByStudentModule[sk].bestScore = pct;
    }
  }

  const evaluations = progressList.map((p) => {
    const studentId = p.student?._id?.toString?.() ?? p.student?.toString?.();
    const moduleId = p.module?._id?.toString?.() ?? p.module?.toString?.();
    const sk = `${studentId}_${moduleId}`;
    const quiz = quizByStudentModule[sk] || { totalTries: 0, bestScore: null };
    const studentName =
      p.student?.user?.name ?? (p.student?.user?.email ? `(${p.student.user.email})` : '—');
    const courseName = p.module?.moduleName ?? '—';

    return {
      studentId: studentId ?? null,
      studentName,
      courseId: moduleId ?? null,
      courseName,
      completionRate: p.progress?.percentage ?? 0,
      completedAt: p.completedAt ?? null,
      quizScore: quiz.bestScore != null ? Math.round(quiz.bestScore) : null,
      quizTries: quiz.totalTries,
      status: p.status ?? 'enrolled',
    };
  });

  return {
    summary: {
      totalCourses: Number(totalCourses),
      totalStudentsEnrolled: Number(totalStudentsEnrolled),
    },
    evaluations,
  };
};

export default {
  getEvaluationData,
};
