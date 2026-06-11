import Student from '../models/student.model.js';
import Mentor from '../models/mentor.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';
import { computeEnrollmentStatusBreakdown } from './evaluation.service.js';

const TIME_BUCKETS = 12;

const RANGE_DAYS = { '7d': 7, '30d': 30, '3m': 90, '12m': 365 };

function getDateRange(range) {
  if (!range || !RANGE_DAYS[range]) return null;
  const days = RANGE_DAYS[range];
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const previousEnd = new Date(start);
  previousEnd.setMilliseconds(-1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - days);
  return { start, end, previousStart, previousEnd, days };
}

/**
 * Get training analytics with optional date range and comparison.
 * @param {Object} options - { range?: '7d'|'30d'|'3m'|'12m' }
 * @returns {Promise<Object>}
 */
const getTrainingAnalytics = async (options = {}) => {
  const dateRange = getDateRange(options.range);

  // Only count active students; exclude inactive ones from progress queries
  const activeStudentIds = (
    await Student.find({ status: 'active' }, { _id: 1 }).lean()
  ).map((s) => s._id);

  const baseProgressMatch = {
    student: { $in: activeStudentIds },
    ...(dateRange ? { enrolledAt: { $gte: dateRange.start, $lte: dateRange.end } } : {}),
  };

  const [
    totalStudents,
    totalMentors,
    modulesWithStudents,
    totalEnrollments,
    completionCount,
    progressListForStatus,
    recentProgressList,
    quizAggResult,
    enrollmentsOverTime,
    completionsOverTime,
    quizScoreOverTime,
    completionByModuleAgg,
    quizByModuleAgg,
    notStartedCount,
    notStartedList,
    avgDaysAgg,
    mentorWorkloadModules,
    enrollmentsByCategoryAgg,
    previousEnrollments,
    previousCompletions,
  ] = await Promise.all([
    Student.countDocuments({ status: 'active' }),
    Mentor.countDocuments({}),
    TrainingModule.find({}, { moduleName: 1, students: 1, categories: 1 }).lean(),
    StudentCourseProgress.countDocuments(baseProgressMatch),
    StudentCourseProgress.countDocuments({
      ...baseProgressMatch,
      $or: [{ status: 'completed' }, { 'progress.percentage': { $gte: 100 } }],
      completedAt: dateRange
        ? { $exists: true, $ne: null, $gte: dateRange.start, $lte: dateRange.end }
        : { $exists: true, $ne: null },
    }),
    StudentCourseProgress.find({ student: { $in: activeStudentIds } })
      .select('student module progress completedAt enrolledAt startedAt status certificate')
      .lean(),
    StudentCourseProgress.find({ completedAt: { $exists: true, $ne: null }, student: { $in: activeStudentIds } })
      .sort({ completedAt: -1 })
      .limit(10)
      .populate({ path: 'student', select: 'user', populate: { path: 'user', select: 'name' } })
      .populate({ path: 'module', select: 'moduleName' })
      .lean(),
    StudentQuizAttempt.aggregate([
      { $match: { status: 'graded', student: { $in: activeStudentIds } } },
      { $group: { _id: null, avg: { $avg: '$score.percentage' } } },
    ]),
    StudentCourseProgress.aggregate([
      { $match: { student: { $in: activeStudentIds }, enrolledAt: { $exists: true, $ne: null }, ...(dateRange ? { enrolledAt: { $gte: dateRange.start, $lte: dateRange.end } } : {}) } },
      {
        $group: {
          _id: { year: { $year: '$enrolledAt' }, month: { $month: '$enrolledAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: TIME_BUCKETS },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          period: {
            $dateToString: {
              format: '%b %Y',
              date: { $dateFromParts: { year: '$_id.year', month: '$_id.month', day: 1 } },
            },
          },
          count: 1,
          _id: 0,
        },
      },
    ]),
    StudentCourseProgress.aggregate([
      { $match: { student: { $in: activeStudentIds }, completedAt: { $exists: true, $ne: null }, ...(dateRange ? { completedAt: { $gte: dateRange.start, $lte: dateRange.end } } : {}) } },
      {
        $group: {
          _id: { year: { $year: '$completedAt' }, month: { $month: '$completedAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: TIME_BUCKETS },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          period: {
            $dateToString: {
              format: '%b %Y',
              date: { $dateFromParts: { year: '$_id.year', month: '$_id.month', day: 1 } },
            },
          },
          count: 1,
          _id: 0,
        },
      },
    ]),
    StudentQuizAttempt.aggregate([
      { $match: { status: 'graded', student: { $in: activeStudentIds } } },
      { $addFields: { bucketDate: { $cond: [{ $ne: ['$submittedAt', null] }, '$submittedAt', '$createdAt'] } } },
      { $match: { bucketDate: { $exists: true, $ne: null }, ...(dateRange ? { bucketDate: { $gte: dateRange.start, $lte: dateRange.end } } : {}) } },
      { $group: { _id: { year: { $year: '$bucketDate' }, month: { $month: '$bucketDate' } }, averageScore: { $avg: '$score.percentage' } } },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: TIME_BUCKETS },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          period: {
            $dateToString: {
              format: '%b %Y',
              date: { $dateFromParts: { year: '$_id.year', month: '$_id.month', day: 1 } },
            },
          },
          averageScore: { $round: ['$averageScore', 1] },
          _id: 0,
        },
      },
    ]),
    StudentCourseProgress.aggregate([
      { $match: baseProgressMatch },
      { $group: { _id: '$module', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $gte: ['$progress.percentage', 100] }, 1, 0] } } } },
      { $lookup: { from: 'trainingmodules', localField: '_id', foreignField: '_id', as: 'mod' } },
      { $unwind: { path: '$mod', preserveNullAndEmptyArrays: true } },
      { $project: { moduleId: '$_id', moduleName: '$mod.moduleName', enrolled: '$total', completed: 1, _id: 0 } },
    ]),
    StudentQuizAttempt.aggregate([
      { $match: { status: 'graded', student: { $in: activeStudentIds } } },
      { $group: { _id: '$module', averageScore: { $avg: '$score.percentage' } } },
      { $lookup: { from: 'trainingmodules', localField: '_id', foreignField: '_id', as: 'mod' } },
      { $unwind: { path: '$mod', preserveNullAndEmptyArrays: true } },
      { $project: { moduleId: '$_id', moduleName: '$mod.moduleName', averageScore: { $round: ['$averageScore', 1] }, _id: 0 } },
    ]),
    StudentCourseProgress.countDocuments({
      ...baseProgressMatch,
      $or: [{ 'progress.percentage': 0 }, { 'progress.percentage': { $exists: false } }],
      startedAt: { $exists: false },
    }),
    StudentCourseProgress.find({
      ...baseProgressMatch,
      $or: [{ 'progress.percentage': 0 }, { 'progress.percentage': { $exists: false } }],
    })
      .sort({ enrolledAt: -1 })
      .limit(10)
      .populate({ path: 'student', select: 'user', populate: { path: 'user', select: 'name' } })
      .populate({ path: 'module', select: 'moduleName' })
      .lean(),
    StudentCourseProgress.aggregate([
      { $match: { completedAt: { $exists: true, $ne: null }, student: { $in: activeStudentIds } } },
      { $project: { days: { $divide: [{ $subtract: ['$completedAt', '$enrolledAt'] }, 24 * 60 * 60 * 1000] } } },
      { $group: { _id: null, avgDays: { $avg: '$days' } } },
    ]),
    TrainingModule.find({}, { moduleName: 1, students: 1, mentorsAssigned: 1 })
      .populate({ path: 'mentorsAssigned', select: 'user', populate: { path: 'user', select: 'name' } })
      .lean(),
    TrainingModule.find({ 'students.0': { $exists: true } }, { categories: 1, students: 1 })
      .populate({ path: 'categories', select: 'name' })
      .lean(),
    dateRange
      ? StudentCourseProgress.countDocuments({
          student: { $in: activeStudentIds },
          enrolledAt: { $gte: dateRange.previousStart, $lte: dateRange.previousEnd },
        })
      : Promise.resolve(null),
    dateRange
      ? StudentCourseProgress.countDocuments({
          student: { $in: activeStudentIds },
          completedAt: { $exists: true, $ne: null, $gte: dateRange.previousStart, $lte: dateRange.previousEnd },
        })
      : Promise.resolve(null),
  ]);

  const totalCourses = modulesWithStudents.filter((m) => m.students?.length > 0).length;
  const progressCountByModuleId = new Map(
    (completionByModuleAgg || []).map((r) => [r.moduleId?.toString(), r.enrolled || 0])
  );
  const enrollmentsByModule = modulesWithStudents
    .map((m) => {
      const moduleId = m._id?.toString();
      return {
        moduleId,
        moduleName: m.moduleName || '—',
        enrolledCount: progressCountByModuleId.get(moduleId) ?? 0,
      };
    })
    .filter((r) => r.enrolledCount > 0)
    .sort((a, b) => (b.enrolledCount || 0) - (a.enrolledCount || 0));

  const recentCompletions = recentProgressList.map((p) => ({
    studentName: p.student?.user?.name ?? '—',
    courseName: p.module?.moduleName ?? '—',
    completedAt: p.completedAt,
  }));

  const averageQuizScore = quizAggResult?.[0]?.avg != null ? Math.round(Number(quizAggResult[0].avg)) : null;

  const completionByModule = (completionByModuleAgg || []).map((r) => ({
    moduleId: r.moduleId?.toString(),
    moduleName: r.moduleName || '—',
    enrolled: r.enrolled || 0,
    completed: r.completed || 0,
    completionRate: r.enrolled ? Math.round((r.completed / r.enrolled) * 100) : 0,
  }));

  const quizScoreByModule = (quizByModuleAgg || []).map((r) => ({
    moduleId: r.moduleId?.toString(),
    moduleName: r.moduleName || '—',
    averageScore: r.averageScore != null ? Math.round(r.averageScore) : null,
  }));

  const categoryMap = {};
  for (const mod of enrollmentsByCategoryAgg || []) {
    const count = mod.students?.length ?? 0;
    const cats = mod.categories || [];
    for (const c of cats) {
      const id = c._id?.toString();
      const name = c.name || '—';
      if (!categoryMap[id]) categoryMap[id] = { categoryId: id, categoryName: name, count: 0 };
      categoryMap[id].count += count;
    }
  }
  const enrollmentsByCategory = Object.values(categoryMap).sort((a, b) => (b.count || 0) - (a.count || 0));

  const mentorMap = {};
  for (const mod of mentorWorkloadModules || []) {
    const mentors = mod.mentorsAssigned || [];
    const studentCount = mod.students?.length ?? 0;
    for (const ment of mentors) {
      const id = (typeof ment === 'object' ? ment._id : ment)?.toString?.() || 'unassigned';
      const name = ment?.user?.name || ment?.user?.email || 'Unassigned';
      if (!mentorMap[id]) mentorMap[id] = { mentorId: id, mentorName: name, moduleCount: 0, studentCount: 0 };
      mentorMap[id].moduleCount += 1;
      mentorMap[id].studentCount += studentCount;
    }
  }
  const mentorWorkload = Object.values(mentorMap).sort((a, b) => (b.moduleCount || 0) - (a.moduleCount || 0));

  const averageDaysToComplete = avgDaysAgg?.[0]?.avgDays != null ? Math.round(Number(avgDaysAgg[0].avgDays)) : null;

  const notStarted = (notStartedList || []).map((p) => ({
    studentName: p.student?.user?.name ?? '—',
    courseName: p.module?.moduleName ?? '—',
    enrolledAt: p.enrolledAt,
  }));

  let previousPeriod = null;
  if (dateRange && previousEnrollments != null && previousCompletions != null) {
    previousPeriod = {
      enrollments: Number(previousEnrollments),
      completions: Number(previousCompletions),
      periodLabel: `Previous ${dateRange.days} days`,
    };
  }

  return {
    totalStudents: Number(totalStudents),
    totalMentors: Number(totalMentors),
    totalCourses: Number(totalCourses),
    totalEnrollments: Number(totalEnrollments),
    completionCount: Number(completionCount),
    enrollmentsByModule,
    recentCompletions,
    averageQuizScore,
    enrollmentsOverTime: enrollmentsOverTime || [],
    completionsOverTime: completionsOverTime || [],
    quizScoreOverTime: quizScoreOverTime || [],
    statusBreakdown: computeEnrollmentStatusBreakdown({
      modules: modulesWithStudents,
      progressList: progressListForStatus,
      activeStudentIds: new Set(activeStudentIds.map((id) => id.toString())),
    }),
    completionByModule,
    quizScoreByModule: quizScoreByModule,
    enrollmentsByCategory,
    notStartedCount: Number(notStartedCount),
    notStartedList: notStarted,
    mentorWorkload,
    averageDaysToComplete,
    previousPeriod,
    range: options.range || null,
  };
};

export default {
  getTrainingAnalytics,
};
