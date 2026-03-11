import RecruiterActivityLog from '../models/recruiterActivityLog.model.js';
import User from '../models/user.model.js';

/**
 * Log a recruiter activity
 */
const logActivity = async (recruiterId, activityType, data = {}) => {
  const activityLog = await RecruiterActivityLog.create({
    recruiter: recruiterId,
    activityType,
    description: data.description,
    job: data.jobId,
    candidate: data.candidateId,
    meeting: data.meetingId,
    metadata: data.metadata,
  });
  return activityLog;
};

/**
 * Get activity logs with filters (Admin only)
 * Note: meeting populate skipped - DHARWIN NEW has no Meeting model yet
 */
const getActivityLogs = async (filter = {}, options = {}) => {
  const activeUserIds = (await User.find({ status: 'active' }, { _id: 1 }).lean()).map((u) => u._id);

  const query = { recruiter: { $in: activeUserIds } };

  if (filter.recruiterId) {
    query.recruiter = filter.recruiterId;
  }

  if (filter.activityType) {
    query.activityType = filter.activityType;
  }

  if (filter.startDate || filter.endDate) {
    query.createdAt = {};
    if (filter.startDate) {
      query.createdAt.$gte = new Date(filter.startDate);
    }
    if (filter.endDate) {
      query.createdAt.$lte = new Date(filter.endDate);
    }
  }

  if (filter.jobId) {
    query.job = filter.jobId;
  }

  if (filter.candidateId) {
    query.candidate = filter.candidateId;
  }

  const result = await RecruiterActivityLog.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
  });

  if (result.results && result.results.length > 0) {
    const populatePaths = [
      { path: 'recruiter', select: 'name email role' },
      { path: 'job', select: 'title organisation status' },
      { path: 'candidate', select: 'fullName email' },
      // meeting skipped - no Meeting model in DHARWIN NEW yet
    ];

    for (const doc of result.results) {
      await doc.populate(populatePaths);
    }

    result.results = result.results.map((doc) => {
      const docObj = doc.toObject ? doc.toObject() : doc;

      if (docObj.recruiter) {
        docObj.recruiterName = docObj.recruiter.name || null;
        docObj.recruiterEmail = docObj.recruiter.email || null;
      } else {
        docObj.recruiterName = null;
        docObj.recruiterEmail = null;
      }

      if (docObj.candidate) {
        docObj.candidateName = docObj.candidate.fullName || null;
        docObj.candidateEmail = docObj.candidate.email || null;
      } else {
        docObj.candidateName = null;
        docObj.candidateEmail = null;
      }

      return docObj;
    });
  }

  return result;
};

/**
 * Get activity logs summary by recruiter (Admin only)
 */
const getActivityLogsSummary = async (filter = {}) => {
  // Only include logs from active, existing users
  const activeUserIds = (await User.find({ status: 'active' }, { _id: 1 }).lean()).map((u) => u._id);

  const matchQuery = { recruiter: { $in: activeUserIds } };

  if (filter.recruiterId) {
    matchQuery.recruiter = filter.recruiterId;
  }

  if (filter.startDate || filter.endDate) {
    matchQuery.createdAt = {};
    if (filter.startDate) {
      matchQuery.createdAt.$gte = new Date(filter.startDate);
    }
    if (filter.endDate) {
      matchQuery.createdAt.$lte = new Date(filter.endDate);
    }
  }

  const summary = await RecruiterActivityLog.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: {
          recruiter: '$recruiter',
          activityType: '$activityType',
        },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: '$_id.recruiter',
        activities: {
          $push: {
            activityType: '$_id.activityType',
            count: '$count',
          },
        },
        totalActivities: { $sum: '$count' },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'recruiter',
      },
    },
    {
      $unwind: {
        path: '$recruiter',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        recruiter: {
          id: '$recruiter._id',
          name: '$recruiter.name',
          email: '$recruiter.email',
          role: '$recruiter.role',
        },
        activities: 1,
        totalActivities: 1,
      },
    },
    { $sort: { totalActivities: -1 } },
  ]);

  return summary;
};

/**
 * Get activity statistics (Admin only)
 */
const getActivityStatistics = async (filter = {}) => {
  const activeUserIds = (await User.find({ status: 'active' }, { _id: 1 }).lean()).map((u) => u._id);

  const matchQuery = { recruiter: { $in: activeUserIds } };

  if (filter.recruiterId) {
    matchQuery.recruiter = filter.recruiterId;
  }

  if (filter.startDate || filter.endDate) {
    matchQuery.createdAt = {};
    if (filter.startDate) {
      matchQuery.createdAt.$gte = new Date(filter.startDate);
    }
    if (filter.endDate) {
      matchQuery.createdAt.$lte = new Date(filter.endDate);
    }
  }

  const stats = await RecruiterActivityLog.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: '$activityType',
        count: { $sum: 1 },
      },
    },
  ]);

  const statistics = {
    jobPostingsCreated: 0,
    candidatesScreened: 0,
    interviewsScheduled: 0,
    notesAdded: 0,
    feedbackAdded: 0,
    total: 0,
  };

  stats.forEach((stat) => {
    switch (stat._id) {
      case 'job_posting_created':
        statistics.jobPostingsCreated = stat.count;
        break;
      case 'candidate_screened':
        statistics.candidatesScreened = stat.count;
        break;
      case 'interview_scheduled':
        statistics.interviewsScheduled = stat.count;
        break;
      case 'note_added':
        statistics.notesAdded = stat.count;
        break;
      case 'feedback_added':
        statistics.feedbackAdded = stat.count;
        break;
      default:
        break;
    }
    statistics.total += stat.count;
  });

  return statistics;
};

export {
  logActivity,
  getActivityLogs,
  getActivityLogsSummary,
  getActivityStatistics,
};
