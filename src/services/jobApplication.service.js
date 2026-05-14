import httpStatus from 'http-status';
import JobApplication from '../models/jobApplication.model.js';
import Employee from '../models/employee.model.js';
import { getJobById, isOwnerOrAdmin } from './job.service.js';
import { syncReferralPipelineAfterApplicationWithdrawal, syncReferralPipelineStatusForCandidate } from './referralLeads.service.js';
import ApiError from '../utils/ApiError.js';

const STATUS_VALUES = ['Applied', 'Screening', 'Interview', 'Shortlisted', 'Offered', 'Hired', 'Rejected'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Narrow application query to jobs that still exist with status Active.
 * Drops orphaned applications (job deleted) and applications for Draft/Closed/Archived jobs.
 */
const applyActiveJobsOnlyFilter = async (query) => {
  const Job = (await import('../models/job.model.js')).default;
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

const isActiveJobsOnlyFlag = (filter) => {
  const v = filter?.activeJobsOnly;
  return v === true || v === 'true' || v === '1' || v === 1;
};

/**
 * Get job application by id
 * @param {ObjectId} id
 * @returns {Promise<JobApplication|null>}
 */
const getJobApplicationById = async (id) => {
  const application = await JobApplication.findById(id)
    .populate('job', 'title organisation status createdBy')
    .populate({
      path: 'candidate',
      select: 'fullName email phoneNumber countryCode address owner',
      populate: { path: 'owner', select: 'name email' },
    })
    .populate('applicantUser', 'name email')
    .populate('appliedBy', 'name email');
  return application;
};

/**
 * Create a job application
 * @param {Object} body - { job, candidate, status?, coverLetter?, notes? }
 * @param {Object} currentUser
 * @returns {Promise<JobApplication>}
 */
const createJobApplication = async (body, currentUser) => {
  const job = await getJobById(body.job);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to this job');
  }
  const candidate = await Employee.findById(body.candidate);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  const existing = await JobApplication.findOne({ job: body.job, candidate: body.candidate });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'This candidate has already applied to this job');
  }
  // applicantUser is intentionally left NULL here. We do not auto-derive it from
  // Employee.owner: for recruiter-created candidates, Employee.owner IS the recruiter's
  // User and would leak the recruiter's email into the applicant row. A reliable
  // applicant-user link is only available when the candidate self-registers, which goes
  // through a different create path. Frontend resolver falls back to candidate.email
  // (the Employee's own email) for these rows — which is correct.
  const applicantUserId = null;
  const application = await JobApplication.create({
    job: body.job,
    candidate: body.candidate,
    applicantUser: applicantUserId,
    status: body.status || 'Applied',
    coverLetter: body.coverLetter,
    notes: body.notes,
    appliedBy: currentUser.id,
  });
  await syncReferralPipelineStatusForCandidate(body.candidate);
  await application.populate([
    { path: 'job', select: 'title organisation status' },
    { path: 'candidate', select: 'fullName email phoneNumber' },
    { path: 'appliedBy', select: 'name email' },
  ]);
  return application;
};

/**
 * Update job application (status, notes, coverLetter, job, candidate)
 * @param {ObjectId} id - Application id
 * @param {Object} updateBody - { status?, notes?, coverLetter?, job?, candidate? }
 * @param {Object} currentUser
 * @returns {Promise<JobApplication>}
 */
const updateJobApplicationStatus = async (id, updateBody, currentUser) => {
  const application = await JobApplication.findById(id);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }

  const job = await getJobById(application.job);
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  const { status, notes, coverLetter, job: jobId, candidate: candidateId } = updateBody;

  if (jobId != null && jobId !== undefined) {
    const newJob = await getJobById(jobId);
    if (!newJob) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
    }
    const canAccessNew = await isOwnerOrAdmin(currentUser, newJob);
    if (!canAccessNew) {
      throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to that job');
    }
    application.job = jobId;
  }
  if (candidateId != null && candidateId !== undefined) {
    const candidate = await Employee.findById(candidateId);
    if (!candidate) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
    }
    application.candidate = candidateId;
  }
  // If job or candidate changed, check unique (job, candidate)
  const existing = await JobApplication.findOne({
    job: application.job,
    candidate: application.candidate,
    _id: { $ne: application._id },
  });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'This candidate has already applied to this job');
  }

  if (status != null && status !== undefined) {
    if (!STATUS_VALUES.includes(status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Status must be one of: ${STATUS_VALUES.join(', ')}`);
    }
    application.status = status;
  }
  if (notes !== undefined) {
    application.notes = notes;
  }
  if (coverLetter !== undefined) {
    application.coverLetter = coverLetter;
  }

  await application.save();
  await syncReferralPipelineStatusForCandidate(application.candidate);
  await application.populate([
    { path: 'job', select: 'title organisation status' },
    { path: 'candidate', select: 'fullName email phoneNumber' },
    { path: 'appliedBy', select: 'name email' },
  ]);

  if (status != null && status !== undefined && application.candidate?.email) {
    const { notifyByEmail, plainTextEmailBody } = await import('./notification.service.js');
    const jobTitle = application.job?.title || 'Job';
    const msg = `Your application for "${jobTitle}" is now ${application.status}.`;
    notifyByEmail(application.candidate.email, {
      type: 'job_application',
      title: `Application status: ${application.status}`,
      message: msg,
      link: '/ats/my-applications',
      email: {
        subject: `Application status: ${application.status} — ${jobTitle}`,
        text: plainTextEmailBody(msg, '/ats/my-applications'),
      },
    }).catch(() => {});
  }

  return application;
};

/**
 * Delete job application
 * @param {ObjectId} id
 * @param {Object} currentUser
 * @returns {Promise<void>}
 */
const deleteJobApplication = async (id, currentUser) => {
  const application = await JobApplication.findById(id);
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }
  const job = await getJobById(application.job);
  const canAccess = await isOwnerOrAdmin(currentUser, job);
  if (!canAccess) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const candidateId = application.candidate;
  const withdrawnJobId = application.job;
  await JobApplication.findByIdAndDelete(id);
  await syncReferralPipelineAfterApplicationWithdrawal(candidateId, { withdrawnJobId });
};

/**
 * Query job applications with filter and pagination
 * @param {Object} filter - { jobId?, candidateId?, status? }
 * @param {Object} options - pagination options
 * @param {Object} currentUser - for access check (filter by job ownership if not admin)
 * @returns {Promise<QueryResult>}
 */
const queryJobApplications = async (filter, options, currentUser) => {
  const { userIsAdmin } = await import('../utils/roleHelpers.js');
  const query = {};

  if (filter.jobId) {
    query.job = filter.jobId;
  }
  if (filter.candidateId) {
    query.candidate = filter.candidateId;
  }
  if (filter.status) {
    query.status = filter.status;
  }
  if (filter.recruiterId) {
    query.appliedBy = filter.recruiterId;
  }

  // Drop synthetic offer-letter applications (placeholder candidates with relay emails).
  // Default is to keep them; pass excludeInternal=true to filter them out (Applications page).
  const RELAY_EMAIL_RE = /(\.noreply@dharwin\.offers\.local$)|(\.(local|internal|invalid)$)/i;
  const wantExcludeInternal =
    filter.excludeInternal === true ||
    filter.excludeInternal === 'true' ||
    filter.excludeInternal === 1 ||
    filter.excludeInternal === '1';
  if (wantExcludeInternal) {
    const syntheticRows = await Employee.find(
      { email: RELAY_EMAIL_RE },
      { _id: 1 }
    ).lean();
    if (syntheticRows.length > 0) {
      const syntheticIds = syntheticRows.map((r) => r._id);
      if (query.candidate == null) {
        query.candidate = { $nin: syntheticIds };
      } else if (typeof query.candidate === 'object' && Array.isArray(query.candidate.$in)) {
        const blocked = new Set(syntheticIds.map(String));
        query.candidate = {
          $in: query.candidate.$in.filter((id) => !blocked.has(String(id))),
        };
      } else if (syntheticIds.some((id) => String(id) === String(query.candidate))) {
        const limit = options.limit || 10;
        return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
      }
    }
  }
  if (filter.dateFrom || filter.dateTo) {
    query.createdAt = {};
    if (filter.dateFrom) query.createdAt.$gte = new Date(filter.dateFrom);
    if (filter.dateTo) query.createdAt.$lte = new Date(filter.dateTo);
  }

  // Department filter — resolve candidate ids whose Employee.department matches
  let departmentCandidateIds = null;
  if (filter.department) {
    const depRows = await Employee.find(
      { department: new RegExp(`^${escapeRegex(filter.department)}$`, 'i') },
      { _id: 1 }
    ).lean();
    departmentCandidateIds = depRows.map((r) => r._id);
    if (departmentCandidateIds.length === 0) {
      const limit = options.limit || 10;
      return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
    }
  }

  // Only include applications from active candidates whose owner user account is also active/pending.
  // This ensures the list count matches the analytics dashboard count exactly.
  if (filter.includeInactive !== true && !query.candidate) {
    const User = (await import('../models/user.model.js')).default;
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
      if (intersected.length === 0) {
        const limit = options.limit || 10;
        return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
      }
      query.candidate = { $in: intersected };
    } else {
      query.candidate = { $in: activeCandidateIds };
    }
  } else if (departmentCandidateIds && !query.candidate) {
    query.candidate = { $in: departmentCandidateIds };
  } else if (departmentCandidateIds && query.candidate) {
    if (!departmentCandidateIds.some((id) => String(id) === String(query.candidate))) {
      const limit = options.limit || 10;
      return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
    }
  }

  // Text search: match candidate fullName/email OR job title
  if (filter.q && filter.q.trim()) {
    const Job = (await import('../models/job.model.js')).default;
    const qRegex = new RegExp(escapeRegex(filter.q.trim()), 'i');
    const [candRows, jobRows] = await Promise.all([
      Employee.find({ $or: [{ fullName: qRegex }, { email: qRegex }] }, { _id: 1 }).lean(),
      Job.find({ title: qRegex }, { _id: 1 }).lean(),
    ]);
    const candIds = candRows.map((r) => r._id);
    const jobIds = jobRows.map((r) => r._id);
    if (candIds.length === 0 && jobIds.length === 0) {
      const limit = options.limit || 10;
      return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
    }
    query.$or = [{ candidate: { $in: candIds } }, { job: { $in: jobIds } }];
  }

  const isAdmin = await userIsAdmin(currentUser);
  // When filtering by candidate, do not scope to "jobs I created" — referral applications are often
  // for jobs created by another user; schedule interview (interviews.manage) and listing still
  // require `candidates.read` on the route.
  if (!isAdmin && currentUser?.id && !filter.candidateId) {
    const Job = (await import('../models/job.model.js')).default;
    const myJobs = await Job.find({ createdBy: currentUser.id }, { _id: 1 }).lean();
    const myJobIds = myJobs.map((j) => j._id.toString());
    if (query.job) {
      const jobStr = String(query.job);
      if (!myJobIds.includes(jobStr)) {
        const limit = options.limit || 10;
        return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
      }
    } else {
      query.job = { $in: myJobs.map((j) => j._id) };
    }
  }

  if (isActiveJobsOnlyFlag(filter)) {
    const hasMatchingJobs = await applyActiveJobsOnlyFilter(query);
    if (!hasMatchingJobs) {
      const limit = options.limit || 10;
      return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
    }
  }

  // Dedupe applicants by universal user identity (Employee.owner → User._id).
  // Falls back to the candidate Employee _id when owner is missing (legacy rows / synthetic
  // standalone-offer Employees). Latest application per (job, applicant) wins.
  // Default ON; opt out via filter.includeDuplicates=true (analytics/exports).
  const wantDedupe =
    filter.includeDuplicates !== true &&
    filter.includeDuplicates !== 'true' &&
    filter.includeDuplicates !== 1 &&
    filter.includeDuplicates !== '1';
  if (wantDedupe) {
    // JS-side dedupe (not aggregation): Mongoose find() auto-casts string ObjectIds, avoids
    // $match casting gotchas, and never silently drops applications whose Employee.owner
    // lookup misses (employee/internal/legacy rows still surface — we fall back to the
    // candidate _id as the identity key).
    const candDocs = await JobApplication.find(query)
      .select('_id job candidate applicantUser createdAt')
      .lean();
    if (candDocs.length === 0) {
      const limit = options.limit || 10;
      return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
    }

    candDocs.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return String(b._id).localeCompare(String(a._id));
    });

    // Identity key: applicantUser when set (authoritative), else candidate Employee _id.
    // We deliberately do NOT fall back to Employee.owner — for recruiter-created candidates
    // Employee.owner is the recruiter's User account, which would collapse multiple
    // distinct applicants into one row and leak admin/recruiter email into the resolver.
    const seenByJobAndApplicant = new Set();
    const uniqueIds = [];
    for (const d of candDocs) {
      const applicantUserKey = d.applicantUser ? String(d.applicantUser) : null;
      const applicantKey = applicantUserKey || String(d.candidate);
      const composite = `${String(d.job ?? '')}::${applicantKey}`;
      if (seenByJobAndApplicant.has(composite)) continue;
      seenByJobAndApplicant.add(composite);
      uniqueIds.push(d._id);
    }

    if (uniqueIds.length === 0) {
      const limit = options.limit || 10;
      return { results: [], page: 1, limit, totalPages: 0, totalResults: 0 };
    }
    query._id = { $in: uniqueIds };
  }

  const result = await JobApplication.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    populate: [
      { path: 'job', select: 'title organisation status' },
      {
        path: 'candidate',
        select:
          'fullName email phoneNumber countryCode isActive address department designation documents profilePicture owner',
        populate: { path: 'owner', select: 'name email' },
      },
      { path: 'applicantUser', select: 'name email' },
      { path: 'appliedBy', select: 'name email' },
    ],
  });

  // Temporary diagnostic — enabled with ?debug=1. Emits one structured line per row so we
  // can pin down exactly why a given row resolves to "Email hidden" (missing applicantUser,
  // synthetic candidate, etc.). Remove once data audit is complete.
  if (filter.debug === '1' || filter.debug === 1 || filter.debug === true) {
    for (const r of result.results || []) {
      const cand = r.candidate || {};
      const applicantUser = r.applicantUser || null;
      const appliedBy = r.appliedBy || null;
      const candEmail = typeof cand.email === 'string' ? cand.email : null;
      const isSyntheticCandidate = candEmail ? RELAY_EMAIL_RE.test(candEmail) : false;
      let resolvedEmail = null;
      let resolvedSource = null;
      if (isSyntheticCandidate) {
        resolvedEmail = null;
        resolvedSource = 'synthetic_candidate_suppressed';
      } else if (applicantUser?.email && !RELAY_EMAIL_RE.test(applicantUser.email)) {
        resolvedEmail = applicantUser.email;
        resolvedSource = 'applicantUser.email';
      } else if (candEmail && !RELAY_EMAIL_RE.test(candEmail)) {
        resolvedEmail = candEmail;
        resolvedSource = 'candidate.email';
      } else {
        resolvedSource = 'no_public_email';
      }
      // eslint-disable-next-line no-console
      console.log('[applicants:debug]', JSON.stringify({
        applicationId: String(r._id ?? r.id ?? ''),
        jobId: String(r.job?._id ?? r.job?.id ?? r.job ?? ''),
        candidateId: String(cand._id ?? cand.id ?? ''),
        applicantUserId: applicantUser ? String(applicantUser._id ?? applicantUser.id ?? '') : null,
        appliedByUserId: appliedBy ? String(appliedBy._id ?? appliedBy.id ?? '') : null,
        candidateOwnerUserId: cand.owner ? String(cand.owner._id ?? cand.owner.id ?? cand.owner ?? '') : null,
        candidateEmail: candEmail,
        applicantUserEmail: applicantUser?.email ?? null,
        appliedByEmail: appliedBy?.email ?? null,
        isSyntheticCandidate,
        resolvedEmail,
        resolvedSource,
      }));
    }
  }

  return result;
};

export {
  getJobApplicationById,
  updateJobApplicationStatus,
  queryJobApplications,
  createJobApplication,
  deleteJobApplication,
  STATUS_VALUES,
};
