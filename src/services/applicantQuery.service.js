import JobApplication from '../models/jobApplication.model.js';
import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
import User from '../models/user.model.js';
import { applicationScope } from './visibilityScope.service.js';

const RELAY_EMAIL_RE = /(\.noreply@dharwin\.offers\.local$)|(\.(local|internal|invalid)$)/i;

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const emptyPaginated = (options = {}) => {
  const limit = Number(options.limit) || 10;
  return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
};

const mergeScopedQuery = (scopeFilter = {}, query = {}) => {
  if (!scopeFilter || !Object.keys(scopeFilter).length) return query;
  if (!query || !Object.keys(query).length) return scopeFilter;
  return { $and: [scopeFilter, query] };
};

const buildApplicantQuery = async (filter = {}, currentUser = {}) => {
  const query = {};
  const { filter: scopeFilter, scopeDebug } = await applicationScope(currentUser, 'read');

  if (filter.jobId) query.job = filter.jobId;
  if (filter.candidateId) query.candidate = filter.candidateId;
  if (filter.status) query.status = filter.status;
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
    const [candRows, jobRows] = await Promise.all([
      Employee.find({ $or: [{ fullName: qRegex }, { email: qRegex }] }, { _id: 1 }).lean(),
      Job.find({ title: qRegex }, { _id: 1 }).lean(),
    ]);
    const candIds = candRows.map((r) => r._id);
    const jobIds = jobRows.map((r) => r._id);
    if (!candIds.length && !jobIds.length) return { query: { _id: { $in: [] } }, scopeDebug };
    query.$or = [{ candidate: { $in: candIds } }, { job: { $in: jobIds } }];
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
  for (const d of candDocs) {
    const applicantUserKey = d.applicantUser ? String(d.applicantUser) : null;
    const applicantKey = applicantUserKey || String(d.candidate);
    const composite = `${String(d.job ?? '')}::${applicantKey}`;
    if (seen.has(composite)) continue;
    seen.add(composite);
    uniqueIds.push(d._id);
  }
  if (!uniqueIds.length) return { ...query, _id: { $in: [] } };
  return mergeScopedQuery(query, { _id: { $in: uniqueIds } });
};

const queryApplicants = async (filter = {}, options = {}, currentUser = {}) => {
  const { query, scopeDebug } = await buildApplicantQuery(filter, currentUser);
  if (query?._id?.$in && query._id.$in.length === 0) return emptyPaginated(options);
  const finalQuery = await applyDedupeIfRequested(query, filter);
  if (finalQuery?._id?.$in && finalQuery._id.$in.length === 0) return emptyPaginated(options);

  return JobApplication.paginate(finalQuery, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'job', select: 'title organisation status' },
      {
        path: 'candidate',
        select: 'fullName email phoneNumber countryCode isActive address department designation documents profilePicture owner',
        populate: { path: 'owner', select: 'name email' },
      },
      { path: 'applicantUser', select: 'name email' },
      { path: 'appliedBy', select: 'name email' },
    ],
    _scopeDebug: scopeDebug,
  });
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
  return JobApplication.aggregate([
    { $match: finalQuery },
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $project: { _id: 0, status: '$_id', count: 1 } },
  ]);
};

export { buildApplicantQuery, queryApplicants, countApplicants, aggregateApplicantsByStatus };

export default {
  buildApplicantQuery,
  queryApplicants,
  countApplicants,
  aggregateApplicantsByStatus,
};
