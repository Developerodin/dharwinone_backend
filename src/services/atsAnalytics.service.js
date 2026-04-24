import mongoose from 'mongoose';
import Job from '../models/job.model.js';
import Employee from '../models/employee.model.js';
import JobApplication from '../models/jobApplication.model.js';
import User from '../models/user.model.js';
import { getActivityStatistics, getActivityLogsSummary } from './recruiterActivity.service.js';
import { ensureCandidateProfilesForActiveCandidateUsers } from './employee.service.js';
import { userHasRecruiterRole } from '../utils/roleHelpers.js';

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

function timeSeriesPipeline(dateField, extraMatch = {}, dateRange = null) {
  const match = { [dateField]: { $exists: true, $ne: null } };
  if (dateRange) {
    match[dateField] = { $gte: dateRange.start, $lte: dateRange.end };
  }
  Object.assign(match, extraMatch);

  return [
    { $match: match },
    {
      $group: {
        _id: { year: { $year: `$${dateField}` }, month: { $month: `$${dateField}` } },
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
  ];
}

const getAtsAnalytics = async (options = {}, user = {}) => {
  const dateRange = getDateRange(options.range);
  const isRecruiter = await userHasRecruiterRole(user);

  const recruiterJobIds = isRecruiter
    ? (await Job.find({ createdBy: user._id }, { _id: 1 }).lean()).map((j) => j._id)
    : null;

  const ownerIdsWithCandidateRole = await ensureCandidateProfilesForActiveCandidateUsers();
  const ownerClause =
    ownerIdsWithCandidateRole === null
      ? {}
      : { owner: ownerIdsWithCandidateRole.length > 0 ? { $in: ownerIdsWithCandidateRole } : { $in: [] } };

  const candidateMatch = {
    ...(isRecruiter ? { assignedRecruiter: user._id, isActive: { $ne: false } } : { isActive: { $ne: false } }),
    ...ownerClause,
  };
  const jobMatch = isRecruiter ? { createdBy: user._id } : {};
  const activityFilter = isRecruiter ? { recruiterId: user._id } : {};

  const appDateMatch = dateRange ? { createdAt: { $gte: dateRange.start, $lte: dateRange.end } } : {};

  // Active candidate docs for application metrics — same owner/Candidate-role rule as list + totals
  const activeCandidateIds = (
    await Employee.find({ isActive: { $ne: false }, ...ownerClause }, { _id: 1 }).lean()
  ).map((c) => c._id);

  const existingJobIds = (await Job.find({}, { _id: 1 }).lean()).map((j) => j._id);

  const appMatch = {
    candidate: { $in: activeCandidateIds },
    job: { $in: isRecruiter ? recruiterJobIds : existingJobIds },
  };

  const [
    totalCandidates,
    totalJobs,
    activeJobs,
    totalApplications,
    hiredCount,
    totalRecruiters,
    avgProfileAgg,
    applicationFunnelAgg,
    applicationsOverTime,
    jobsOverTime,
    jobStatusAgg,
    jobTypeAgg,
    applicationStatusAgg,
    topJobsAgg,
    recruiterActivityStats,
    recruiterActivitySummary,
    previousApplications,
    previousHired,
  ] = await Promise.all([
    Employee.countDocuments(candidateMatch),
    Job.countDocuments(jobMatch),
    Job.countDocuments({ ...jobMatch, status: 'Active' }),
    JobApplication.countDocuments({ ...appMatch, ...appDateMatch }),
    JobApplication.countDocuments({ ...appMatch, ...appDateMatch, status: 'Hired' }),
    isRecruiter
      ? Promise.resolve(1)
      : (async () => {
          const Role = (await import('../models/role.model.js')).default;
          const recruiterRole = await Role.findOne({ name: 'Recruiter', status: 'active' }).select('_id').lean();
          return recruiterRole ? User.countDocuments({ roleIds: recruiterRole._id }) : 0;
        })(),
    Employee.aggregate([
      { $match: candidateMatch },
      { $group: { _id: null, avg: { $avg: '$isProfileCompleted' } } },
    ]),
    JobApplication.aggregate([
      { $match: { ...appMatch, ...appDateMatch } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { status: '$_id', count: 1, _id: 0 } },
    ]),
    JobApplication.aggregate(timeSeriesPipeline('createdAt', appMatch, dateRange)),
    Job.aggregate(timeSeriesPipeline('createdAt', jobMatch, dateRange)),
    Job.aggregate([
      { $match: jobMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { status: '$_id', count: 1, _id: 0 } },
    ]),
    Job.aggregate([
      { $match: jobMatch },
      { $group: { _id: '$jobType', count: { $sum: 1 } } },
      { $project: { jobType: '$_id', count: 1, _id: 0 } },
    ]),
    JobApplication.aggregate([
      { $match: { ...appMatch, ...appDateMatch } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { status: '$_id', count: 1, _id: 0 } },
    ]),
    JobApplication.aggregate([
      { $match: { ...appMatch, ...appDateMatch } },
      { $group: { _id: '$job', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'jobs', localField: '_id', foreignField: '_id', as: 'jobDoc' } },
      { $unwind: { path: '$jobDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          jobId: '$_id',
          title: '$jobDoc.title',
          org: '$jobDoc.organisation.name',
          count: 1,
          _id: 0,
        },
      },
    ]),
    getActivityStatistics({
      ...activityFilter,
      ...(dateRange ? { startDate: dateRange.start, endDate: dateRange.end } : {}),
    }),
    getActivityLogsSummary({
      ...activityFilter,
      ...(dateRange ? { startDate: dateRange.start, endDate: dateRange.end } : {}),
    }),
    dateRange
      ? JobApplication.countDocuments({
          ...appMatch,
          createdAt: { $gte: dateRange.previousStart, $lte: dateRange.previousEnd },
        })
      : Promise.resolve(null),
    dateRange
      ? JobApplication.countDocuments({
          ...appMatch,
          status: 'Hired',
          createdAt: { $gte: dateRange.previousStart, $lte: dateRange.previousEnd },
        })
      : Promise.resolve(null),
  ]);

  const avgProfileCompletion =
    avgProfileAgg?.[0]?.avg != null ? Math.round(Number(avgProfileAgg[0].avg)) : 0;
  const conversionRate =
    totalApplications > 0 ? Math.round((hiredCount / totalApplications) * 100 * 10) / 10 : 0;

  let previousPeriod = null;
  if (dateRange && previousApplications != null && previousHired != null) {
    previousPeriod = {
      applications: Number(previousApplications),
      hired: Number(previousHired),
      periodLabel: `Previous ${dateRange.days} days`,
    };
  }

  return {
    totals: {
      totalCandidates: Number(totalCandidates),
      totalJobs: Number(totalJobs),
      activeJobs: Number(activeJobs),
      totalApplications: Number(totalApplications),
      hiredCount: Number(hiredCount),
      totalRecruiters: Number(totalRecruiters),
      conversionRate,
      avgProfileCompletion,
    },
    previousPeriod,
    applicationFunnel: applicationFunnelAgg || [],
    applicationsOverTime: applicationsOverTime || [],
    jobsOverTime: jobsOverTime || [],
    jobStatusBreakdown: jobStatusAgg || [],
    jobTypeDistribution: jobTypeAgg || [],
    applicationStatusBreakdown: applicationStatusAgg || [],
    topJobsByApplications: topJobsAgg || [],
    recruiterActivityStats,
    recruiterActivitySummary: recruiterActivitySummary || [],
    range: options.range || null,
  };
};

const getDrillDown = async (params, user = {}) => {
  const { type, value, page = 1, limit = 20 } = params;
  const isRecruiter = await userHasRecruiterRole(user);
  const skip = (page - 1) * limit;

  if (type === 'applicationStatus' || type === 'applicationFunnel') {
    const ownerIdsWithCandidateRole = await ensureCandidateProfilesForActiveCandidateUsers();
    const ownerClause =
      ownerIdsWithCandidateRole === null
        ? {}
        : { owner: ownerIdsWithCandidateRole.length > 0 ? { $in: ownerIdsWithCandidateRole } : { $in: [] } };
    const activeCandidateIds = (
      await Employee.find({ isActive: { $ne: false }, ...ownerClause }, { _id: 1 }).lean()
    ).map((c) => c._id);

    const query = { status: value, candidate: { $in: activeCandidateIds } };
    if (isRecruiter) {
      const recruiterJobIds = (await Job.find({ createdBy: user._id }, { _id: 1 }).lean()).map((j) => j._id);
      query.job = { $in: recruiterJobIds };
    } else {
      const existingJobIds = (await Job.find({}, { _id: 1 }).lean()).map((j) => j._id);
      query.job = { $in: existingJobIds };
    }
    const [results, total] = await Promise.all([
      JobApplication.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'job', select: 'title organisation' })
        .populate({ path: 'candidate', select: 'fullName email' })
        .lean(),
      JobApplication.countDocuments(query),
    ]);
    return {
      results: results.map((r) => ({
        id: r._id,
        candidateName: r.candidate?.fullName || '—',
        candidateEmail: r.candidate?.email || '—',
        jobTitle: r.job?.title || '—',
        organisation: r.job?.organisation?.name || '—',
        status: r.status,
        appliedAt: r.createdAt,
      })),
      page,
      limit,
      totalResults: total,
      totalPages: Math.ceil(total / limit),
    };
  }

  if (type === 'jobStatus') {
    const query = { status: value };
    if (isRecruiter) query.createdBy = user._id;
    const [results, total] = await Promise.all([
      Job.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(query),
    ]);
    return {
      results: results.map((r) => ({
        id: r._id,
        title: r.title,
        organisation: r.organisation?.name || '—',
        status: r.status,
        jobType: r.jobType,
        createdAt: r.createdAt,
      })),
      page,
      limit,
      totalResults: total,
      totalPages: Math.ceil(total / limit),
    };
  }

  if (type === 'jobType') {
    const query = { jobType: value };
    if (isRecruiter) query.createdBy = user._id;
    const [results, total] = await Promise.all([
      Job.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(query),
    ]);
    return {
      results: results.map((r) => ({
        id: r._id,
        title: r.title,
        organisation: r.organisation?.name || '—',
        status: r.status,
        jobType: r.jobType,
        createdAt: r.createdAt,
      })),
      page,
      limit,
      totalResults: total,
      totalPages: Math.ceil(total / limit),
    };
  }

  return { results: [], page, limit, totalResults: 0, totalPages: 0 };
};

/**
 * Get applications-over-time (last 5 weeks) per candidate for sparkline charts.
 * @param {string[]} candidateIds - Candidate ObjectIds
 * @returns {Promise<Record<string, number[]>>} Map of candidateId -> [count_week4_ago, ..., count_this_week]
 */
const getApplicationsOverTimeByCandidates = async (candidateIds = []) => {
  if (!candidateIds || candidateIds.length === 0) return {};
  const ids = candidateIds.filter(Boolean).map((id) => String(id));
  if (ids.length === 0) return {};

  const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id);
  if (validIds.length === 0) return {};

  const thirtyFiveDaysAgo = new Date();
  thirtyFiveDaysAgo.setDate(thirtyFiveDaysAgo.getDate() - 35);

  const agg = await JobApplication.aggregate([
    {
      $match: {
        candidate: { $in: validIds.map((id) => new mongoose.Types.ObjectId(id)) },
        createdAt: { $gte: thirtyFiveDaysAgo, $lte: new Date() },
      },
    },
    {
      $addFields: {
        daysAgo: { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 86400000] },
      },
    },
    {
      $addFields: {
        weekBucket: { $floor: { $divide: ['$daysAgo', 7] } },
      },
    },
    { $match: { weekBucket: { $gte: 0, $lt: 5 } } },
    {
      $group: {
        _id: { candidate: '$candidate', week: '$weekBucket' },
        count: { $sum: 1 },
      },
    },
  ]);

  const result = {};
  for (const id of validIds) {
    result[String(id)] = [0, 0, 0, 0, 0];
  }
  for (const row of agg) {
    const cid = String(row._id.candidate);
    const w = Number(row._id.week);
    if (result[cid] && w >= 0 && w < 5) {
      result[cid][4 - w] = row.count;
    }
  }
  return result;
};

export default {
  getAtsAnalytics,
  getDrillDown,
  getApplicationsOverTimeByCandidates,
};
