import JobApplication from '../models/jobApplication.model.js';
import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
import User from '../models/user.model.js';
import Meeting from '../models/meeting.model.js';
import { INTERVIEW_SCHEDULE_ELIGIBLE_STATUSES } from '../constants/atsPipeline.js';
import { applicationScope } from './visibilityScope.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { refreshApplicationCandidateProfilePictures } from '../utils/profilePicture.util.js';

const RELAY_EMAIL_RE = /(\.noreply@dharwin\.offers\.local$)|(\.(local|internal|invalid)$)/i;

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

const parseStringList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const emptyPaginated = (options = {}) => {
  const limit = Number(options.limit) || 10;
  return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
};

/** List GET /job-applications — omit detail-only blobs (statusHistory, round plan, Bolna fields). */
const APPLICANT_LIST_SELECT =
  '-statusHistory -roundPlanSnapshot -notes -coverLetter -verificationCallExecutionId -verificationCallInitiatedAt -verificationCallStatus -verificationCallbackAt -verificationCallbackCount -roundCounter';

const APPLICANT_LIST_POPULATE = [
  { path: 'job', select: 'title organisation status' },
  {
    path: 'candidate',
    select:
      'fullName email phoneNumber countryCode isActive address department designation documents profilePicture owner employeeId referralPipelineStatus',
    populate: { path: 'owner', select: 'name email' },
  },
  { path: 'applicantUser', select: 'name email' },
  { path: 'appliedBy', select: 'name email' },
];

const parsePaginateOptions = (options = {}) => {
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const sortBy = options.sortBy || 'createdAt:desc';
  const sort = {};
  sortBy.split(',').forEach((sortOption) => {
    const [key, order] = sortOption.split(':');
    sort[key] = order === 'asc' ? 1 : -1;
  });
  if (sort._id == null) {
    sort._id = sort.createdAt != null ? sort.createdAt : -1;
  }
  return { limit, page, skip: (page - 1) * limit, sortBy, sort };
};

const presignApplicationDocuments = async (apps) => {
  const resign = async (holder, urlField) => {
    if (!holder?.key) return;
    try {
      holder[urlField] = await generatePresignedDownloadUrl(holder.key, 7 * 24 * 3600);
    } catch (_) {
      /* keep stale url if presigning fails */
    }
  };

  await Promise.all(
    (apps || []).map(async (app) => {
      const docs = app.candidate?.documents;
      await Promise.all([
        resign(app.submittedResume, 'documentUrl'),
        resign(app.submittedCoverLetter, 'documentUrl'),
        ...(Array.isArray(docs) ? docs.map((doc) => resign(doc, 'url')) : []),
      ]);
    })
  );
  await refreshApplicationCandidateProfilePictures(apps);
};

const dedupeGroupId = (filter = {}) => {
  const dedupeByCandidateOnly = truthy(filter.distinctCandidates) && truthy(filter.scheduleEligible);
  if (dedupeByCandidateOnly) {
    return { who: { $ifNull: ['$applicantUser', '$candidate'] } };
  }
  return { job: '$job', who: { $ifNull: ['$applicantUser', '$candidate'] } };
};

/**
 * Paginate with the same dedupe rule as applyDedupeIfRequested, without loading every row into Node.
 * Sort + tie-break match applyDedupeIfRequested (newest createdAt, then highest _id).
 */
const paginateDedupedApplicants = async (query, filter = {}, options = {}) => {
  const { limit, page, skip, sort } = parsePaginateOptions(options);
  const groupId = dedupeGroupId(filter);

  const pipeline = [
    { $match: JobApplication.find(query).cast() },
    { $sort: sort },
    {
      $group: {
        _id: groupId,
        docId: { $first: '$_id' },
        createdAt: { $first: '$createdAt' },
      },
    },
    { $sort: { createdAt: sort.createdAt ?? -1, docId: sort._id ?? -1 } },
    {
      $facet: {
        meta: [{ $count: 'totalResults' }],
        ids: [{ $skip: skip }, { $limit: limit }, { $project: { _id: '$docId' } }],
      },
    },
  ];

  const [facetResult] = await JobApplication.aggregate(pipeline);
  const totalResults = facetResult?.meta?.[0]?.totalResults ?? 0;
  const ids = (facetResult?.ids ?? []).map((row) => row._id);
  if (!ids.length) {
    return { results: [], page, limit, totalPages: 0, totalResults };
  }

  const docs = await JobApplication.find({ _id: { $in: ids } })
    .select(APPLICANT_LIST_SELECT)
    .populate(APPLICANT_LIST_POPULATE)
    .lean();

  const order = new Map(ids.map((id, index) => [String(id), index]));
  docs.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));

  await presignApplicationDocuments(docs);

  const totalPages = Math.ceil(totalResults / limit) || 0;
  return { results: docs, page, limit, totalPages, totalResults };
};

const mergeScopedQuery = (scopeFilter = {}, query = {}) => {
  if (!scopeFilter || !Object.keys(scopeFilter).length) return query;
  if (!query || !Object.keys(query).length) return scopeFilter;
  return { $and: [scopeFilter, query] };
};

/** Narrow application query to jobs that still exist with status Active. */
const applyActiveJobsOnlyFilter = async (query) => {
  const rows = await Job.find({ status: 'Active' }).select('_id').lean();
  const activeIds = rows.map((r) => r._id);
  if (activeIds.length === 0) return false;

  const allowed = new Set(activeIds.map((id) => String(id)));

  if (query.job == null) {
    query.job = { $in: activeIds };
    return true;
  }

  const j = query.job;
  if (j && typeof j === 'object' && Array.isArray(j.$in)) {
    const narrowed = j.$in.filter((jid) => allowed.has(String(jid)));
    if (narrowed.length === 0) return false;
    query.job = { $in: narrowed };
    return true;
  }

  return allowed.has(String(j));
};

const buildApplicantQuery = async (filter = {}, currentUser = {}) => {
  const query = {};
  const { filter: scopeFilter, scopeDebug } = await applicationScope(currentUser, 'read');

  if (truthy(filter.scheduleEligible)) {
    if (!filter.jobId && !filter.candidateId && !truthy(filter.distinctCandidates)) {
      return { query: { _id: { $in: [] } }, scopeDebug };
    }
    filter.activeJobsOnly = true;
    filter.excludeInternal = true;
    query.status = { $in: [...INTERVIEW_SCHEDULE_ELIGIBLE_STATUSES] };
  }

  if (filter.jobId) query.job = filter.jobId;
  else if (Array.isArray(filter.jobIds) && filter.jobIds.length) {
    query.job = { $in: filter.jobIds };
  }
  if (filter.candidateId) query.candidate = filter.candidateId;
  if (!truthy(filter.scheduleEligible)) {
    const statusValues = parseStringList(filter.statuses ?? filter.status);
    if (statusValues.length === 1) query.status = statusValues[0];
    else if (statusValues.length > 1) query.status = { $in: statusValues };
  }
  if (filter.recruiterId) query.appliedBy = filter.recruiterId;

  if (truthy(filter.excludeInternal)) {
    const syntheticRows = await Employee.find({ email: RELAY_EMAIL_RE }, { _id: 1 }).lean();
    if (syntheticRows.length > 0) {
      const syntheticIds = syntheticRows.map((r) => r._id);
      if (query.candidate == null) query.candidate = { $nin: syntheticIds };
      else if (typeof query.candidate === 'object' && Array.isArray(query.candidate.$in)) {
        const blocked = new Set(syntheticIds.map(String));
        query.candidate = { $in: query.candidate.$in.filter((id) => !blocked.has(String(id))) };
      } else if (syntheticIds.some((id) => String(id) === String(query.candidate))) {
        return { query: { ...scopeFilter, ...{ _id: { $in: [] } } }, scopeDebug };
      }
    }
  }

  if (filter.dateFrom || filter.dateTo) {
    query.createdAt = {};
    if (filter.dateFrom) query.createdAt.$gte = new Date(filter.dateFrom);
    if (filter.dateTo) query.createdAt.$lte = new Date(filter.dateTo);
  }

  let departmentCandidateIds = null;
  if (filter.department) {
    const depRows = await Employee.find(
      { department: new RegExp(`^${escapeRegex(filter.department)}$`, 'i') },
      { _id: 1 }
    ).lean();
    departmentCandidateIds = depRows.map((r) => r._id);
    if (!departmentCandidateIds.length) return { query: { _id: { $in: [] } }, scopeDebug };
  }

  if (!truthy(filter.includeInactive) && !query.candidate) {
    const activeUserIds = (
      await User.find({ status: { $in: ['active', 'pending'] } }, { _id: 1 }).lean()
    ).map((u) => u._id);
    const activeCandidateIds = (
      await Employee.find(
        { isActive: { $ne: false }, owner: { $in: activeUserIds } },
        { _id: 1 }
      ).lean()
    ).map((c) => c._id);
    if (departmentCandidateIds) {
      const allowed = new Set(activeCandidateIds.map(String));
      const intersected = departmentCandidateIds.filter((id) => allowed.has(String(id)));
      if (!intersected.length) return { query: { _id: { $in: [] } }, scopeDebug };
      query.candidate = { $in: intersected };
    } else {
      query.candidate = { $in: activeCandidateIds };
    }
  } else if (departmentCandidateIds && !query.candidate) {
    query.candidate = { $in: departmentCandidateIds };
  } else if (departmentCandidateIds && query.candidate) {
    if (!departmentCandidateIds.some((id) => String(id) === String(query.candidate))) {
      return { query: { _id: { $in: [] } }, scopeDebug };
    }
  }

  if (filter.q && filter.q.trim()) {
    const qRegex = new RegExp(escapeRegex(filter.q.trim()), 'i');
    if (truthy(filter.scheduleEligible) && (filter.jobId || filter.candidateId)) {
      const candRows = await Employee.find(
        { $or: [{ fullName: qRegex }, { email: qRegex }] },
        { _id: 1 }
      ).lean();
      const candIds = candRows.map((r) => r._id);
      if (!candIds.length) return { query: { _id: { $in: [] } }, scopeDebug };
      if (query.candidate == null) {
        query.candidate = { $in: candIds };
      } else if (typeof query.candidate === 'object' && Array.isArray(query.candidate.$in)) {
        const allowed = new Set(candIds.map(String));
        const intersected = query.candidate.$in.filter((id) => allowed.has(String(id)));
        if (!intersected.length) return { query: { _id: { $in: [] } }, scopeDebug };
        query.candidate = { $in: intersected };
      } else if (!candIds.some((id) => String(id) === String(query.candidate))) {
        return { query: { _id: { $in: [] } }, scopeDebug };
      }
    } else {
      const [candRows, jobRows] = await Promise.all([
        Employee.find({ $or: [{ fullName: qRegex }, { email: qRegex }] }, { _id: 1 }).lean(),
        Job.find({ title: qRegex }, { _id: 1 }).lean(),
      ]);
      const candIds = candRows.map((r) => r._id);
      const jobIds = jobRows.map((r) => r._id);
      if (!candIds.length && !jobIds.length) return { query: { _id: { $in: [] } }, scopeDebug };
      query.$or = [{ candidate: { $in: candIds } }, { job: { $in: jobIds } }];
    }
  }

  if (truthy(filter.activeJobsOnly)) {
    const hasMatchingJobs = await applyActiveJobsOnlyFilter(query);
    if (!hasMatchingJobs) return { query: { _id: { $in: [] } }, scopeDebug };
  }

  return { query: mergeScopedQuery(scopeFilter, query), scopeDebug };
};

const applyDedupeIfRequested = async (query, filter = {}) => {
  const wantDedupe = !truthy(filter.includeDuplicates);
  if (!wantDedupe) return query;

  const candDocs = await JobApplication.find(query).select('_id job candidate applicantUser createdAt').lean();
  if (!candDocs.length) return { ...query, _id: { $in: [] } };

  candDocs.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return String(b._id).localeCompare(String(a._id));
  });

  const seen = new Set();
  const uniqueIds = [];
  const dedupeByCandidateOnly = truthy(filter.distinctCandidates) && truthy(filter.scheduleEligible);
  for (const d of candDocs) {
    const applicantUserKey = d.applicantUser ? String(d.applicantUser) : null;
    const applicantKey = applicantUserKey || String(d.candidate);
    const dedupeKey = dedupeByCandidateOnly ? applicantKey : `${String(d.job ?? '')}::${applicantKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    uniqueIds.push(d._id);
  }
  if (!uniqueIds.length) return { ...query, _id: { $in: [] } };
  return mergeScopedQuery(query, { _id: { $in: uniqueIds } });
};

const queryApplicants = async (filter = {}, options = {}, currentUser = {}) => {
  const { query, scopeDebug } = await buildApplicantQuery(filter, currentUser);
  if (query?._id?.$in && query._id.$in.length === 0) return emptyPaginated(options);

  if (!truthy(filter.includeDuplicates)) {
    const deduped = await paginateDedupedApplicants(query, filter, options);
    if (scopeDebug && options.debug) deduped._scopeDebug = scopeDebug;
    return deduped;
  }

  const result = await JobApplication.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    lean: true,
    select: APPLICANT_LIST_SELECT,
    populate: APPLICANT_LIST_POPULATE,
    _scopeDebug: scopeDebug,
  });

  await presignApplicationDocuments(result?.results);

  return result;
};

const countApplicants = async (filter = {}, currentUser = {}) => {
  const { query } = await buildApplicantQuery(filter, currentUser);
  if (query?._id?.$in && query._id.$in.length === 0) return 0;
  const finalQuery = await applyDedupeIfRequested(query, filter);
  if (finalQuery?._id?.$in && finalQuery._id.$in.length === 0) return 0;
  return JobApplication.countDocuments(finalQuery);
};

const aggregateApplicantsByStatus = async (filter = {}, currentUser = {}) => {
  const { query } = await buildApplicantQuery(filter, currentUser);
  if (query?._id?.$in && query._id.$in.length === 0) return [];
  const finalQuery = await applyDedupeIfRequested(query, filter);
  if (finalQuery?._id?.$in && finalQuery._id.$in.length === 0) return [];

  // JS-side grouping (not aggregation): dedupe already relies on find() because Mongoose
  // auto-casts string ObjectIds for find/countDocuments but aggregate $match does not,
  // which left job analytics funnel/conversion stuck at 0 while totals/recent apps worked.
  const docs = await JobApplication.find(finalQuery).select('status').lean();
  const counts = {};
  for (const doc of docs) {
    const status = doc.status || 'Applied';
    counts[status] = (counts[status] || 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
};

// Stages at or past an interview. Rejected is left out: it does not say how far the applicant got.
const INTERVIEW_OR_LATER_STATUSES = ['Interview', 'Offered', 'Hired'];

/**
 * Applications per job in one grouped query, under the same scope and duplicate rule as
 * countApplicants / aggregateApplicantsByStatus: one row per (job, applicantUser || candidate),
 * the newest kept, unless `filter.includeDuplicates`. So a job's `total` here equals
 * countApplicants({ jobId }) for the same viewer.
 *
 * `interviewed` counts kept applications that have a non-cancelled interview (Meeting.applicationId)
 * or sit at Interview / Offered / Hired — a Rejected-after-interview applicant still counts through
 * the meeting.
 *
 * The filter goes through Query#cast because aggregate $match does not auto-cast string ids
 * (the reason aggregateApplicantsByStatus groups in JS).
 * ponytail: the interview lookup is one indexed probe per kept application; fine to ~100k applications.
 *
 * @param {object} filter - buildApplicantQuery filter (jobIds / jobId / status / includeDuplicates ...)
 * @param {object} currentUser
 * @returns {Promise<Array<{ jobId: string, total: number, byStage: Record<string, number>,
 *   lastAppliedAt: Date|null, interviewed: number }>>}
 */
const aggregateApplicationsByJob = async (filter = {}, currentUser = {}) => {
  const { query } = await buildApplicantQuery(filter, currentUser);
  if (query?._id?.$in && query._id.$in.length === 0) return [];

  const pipeline = [
    { $match: JobApplication.find(query).cast() },
    { $project: { job: 1, candidate: 1, applicantUser: 1, createdAt: 1, status: { $ifNull: ['$status', 'Applied'] } } },
  ];
  if (!truthy(filter.includeDuplicates)) {
    // Same key and tie-break as applyDedupeIfRequested: newest createdAt, then highest _id.
    pipeline.push(
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: { job: '$job', who: { $ifNull: ['$applicantUser', '$candidate'] } },
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } }
    );
  }
  pipeline.push(
    {
      $lookup: {
        from: Meeting.collection.collectionName,
        let: { app: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$applicationId', '$$app'] }, status: { $ne: 'cancelled' } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: '_iv',
      },
    },
    {
      $group: {
        _id: { job: '$job', status: '$status' },
        count: { $sum: 1 },
        lastAppliedAt: { $max: '$createdAt' },
        interviewed: {
          $sum: {
            $cond: [
              { $or: [{ $gt: [{ $size: '$_iv' }, 0] }, { $in: ['$status', INTERVIEW_OR_LATER_STATUSES] }] },
              1,
              0,
            ],
          },
        },
      },
    }
  );

  const rows = await JobApplication.aggregate(pipeline);
  const byJob = new Map();
  for (const r of rows) {
    const jobId = String(r._id.job);
    const e = byJob.get(jobId) || { jobId, total: 0, byStage: {}, lastAppliedAt: null, interviewed: 0 };
    e.total += r.count;
    e.byStage[r._id.status] = (e.byStage[r._id.status] || 0) + r.count;
    e.interviewed += r.interviewed;
    if (r.lastAppliedAt && (!e.lastAppliedAt || r.lastAppliedAt > e.lastAppliedAt)) e.lastAppliedAt = r.lastAppliedAt;
    byJob.set(jobId, e);
  }
  return [...byJob.values()];
};

const STATUS_BREAKDOWN_KEYS = ['Applied', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Hired', 'Rejected'];

const emptyStatusBreakdown = () =>
  Object.fromEntries(STATUS_BREAKDOWN_KEYS.map((key) => [key, 0]));

/**
 * Resolve q for candidate search — name preferred, then email, then User lookup.
 * Enhances q search; does not narrow to owner-only Employee rows.
 *
 * @param {{ q?: string|null, userId?: string|null, email?: string|null }} input
 * @returns {Promise<string|null>}
 */
const resolveApplicantSearchQ = async ({ q = null, userId = null, email = null } = {}) => {
  if (q?.trim()) return q.trim();
  if (email?.trim()) return email.trim();
  if (userId) {
    const user = await User.findById(userId).select('name email').lean();
    if (user?.name?.trim()) return user.name.trim();
    if (user?.email?.trim()) return user.email.trim();
  }
  return null;
};

/**
 * Canonical application search for Sage chatbot and UI parity.
 * Uses same queryApplicants as GET /job-applications.
 *
 * @param {{
 *   q?: string|null,
 *   userId?: string|null,
 *   email?: string|null,
 *   status?: string|null,
 *   jobId?: string|null,
 *   jobIds?: string[]|null,
 *   user: object,
 *   limit?: number,
 *   requireApplicantQ?: boolean,
 * }} opts
 */
const searchApplications = async ({
  q = null,
  userId = null,
  email = null,
  status = null,
  jobId = null,
  jobIds = null,
  candidateIds = null,
  user,
  limit = 50,
  requireApplicantQ = false,
} = {}) => {
  // Exact candidate profiles (e.g. one person's own profiles) replace the name/email/user text search.
  const exactCandidates = Array.isArray(candidateIds) && candidateIds.length ? candidateIds : null;
  const searchQ = exactCandidates ? null : await resolveApplicantSearchQ({ q, userId, email });
  if (requireApplicantQ && !searchQ && !exactCandidates) {
    return {
      total: 0,
      baseTotal: 0,
      breakdown: emptyStatusBreakdown(),
      records: [],
      statusFilter: status || null,
      notFound: true,
      label: 'job application',
    };
  }

  const filter = { excludeInternal: true };
  if (searchQ) filter.q = searchQ;
  if (status) filter.status = status;
  if (jobId) filter.jobId = jobId;
  if (Array.isArray(jobIds) && jobIds.length) filter.jobIds = jobIds;
  if (exactCandidates) filter.candidateId = { $in: exactCandidates };

  const baseFilter = { excludeInternal: true };
  if (searchQ) baseFilter.q = searchQ;
  if (jobId) baseFilter.jobId = jobId;
  if (Array.isArray(jobIds) && jobIds.length) baseFilter.jobIds = jobIds;
  if (exactCandidates) baseFilter.candidateId = { $in: exactCandidates };

  const [result, statusRows] = await Promise.all([
    queryApplicants(filter, { limit, page: 1, sortBy: 'createdAt:desc' }, user),
    aggregateApplicantsByStatus(baseFilter, user),
  ]);

  const breakdown = emptyStatusBreakdown();
  for (const row of statusRows) {
    if (row?.status && row.status in breakdown) breakdown[row.status] = row.count;
  }
  const baseTotal = Object.values(breakdown).reduce((sum, count) => sum + count, 0);

  return {
    total: result.totalResults,
    baseTotal,
    breakdown,
    records: result.results,
    statusFilter: status || null,
    label: 'job application',
  };
};

export {
  buildApplicantQuery,
  queryApplicants,
  countApplicants,
  aggregateApplicantsByStatus,
  aggregateApplicationsByJob,
  resolveApplicantSearchQ,
  searchApplications,
};

export default {
  buildApplicantQuery,
  queryApplicants,
  countApplicants,
  aggregateApplicantsByStatus,
  aggregateApplicationsByJob,
  resolveApplicantSearchQ,
  searchApplications,
};
