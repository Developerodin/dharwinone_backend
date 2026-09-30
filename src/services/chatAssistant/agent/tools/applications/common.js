import mongoose from 'mongoose';
import JobModel from '../../../../../models/job.model.js';
import EmployeeModel from '../../../../../models/employee.model.js';
import UserModel from '../../../../../models/user.model.js';
import { searchApplications as realSearchApplications } from '../../../../applicantQuery.service.js';
import {
  resolveJobVisibilityFilter as realResolveJobVisibilityFilter,
  scopeJobModel,
} from '../../../queryPlanner/entities/jobRank.js';
import { ownsProfile } from '../ownsProfile.js';

// applicantQuery.service's applicationScope is the real gate (admin / interviews.manage / recruiter /
// sales agent / self) — same as the legacy fetch_job_applications, which had no anyOf either.
export const APPLICATIONS_ACCESS = Object.freeze({ note: 'applicantQuery.service applicationScope' });
export const MAX_LIST_LIMIT = 50;

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applicationsScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('application tools need an authenticated user with an id');
  }
  return ctx.user;
}

export function applicationsDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    searchApplications: deps.searchApplications ?? realSearchApplications,
    resolveJobVisibilityFilter: deps.resolveJobVisibilityFilter ?? realResolveJobVisibilityFilter,
    Job: deps.Job ?? JobModel,
    Employee: deps.Employee ?? EmployeeModel,
    User: deps.User ?? UserModel,
  };
}

/**
 * Filters → searchApplications args. A job title resolves only to jobs this viewer can see on the
 * Jobs page. Returns { notFound } when the title or applicant matches nothing.
 */
export async function runApplicationSearch({ filters = {}, limit, user, deps }) {
  let jobId = null;
  let jobIds = null;
  if (filters.jobId && mongoose.Types.ObjectId.isValid(filters.jobId)) {
    jobId = filters.jobId;
  } else if (filters.jobTitle) {
    const visibility = await deps.resolveJobVisibilityFilter(user);
    const ids = await scopeJobModel(deps.Job, visibility)
      .find({ title: { $regex: escapeRegex(filters.jobTitle), $options: 'i' } })
      .distinct('_id');
    if (!ids.length) return { notFound: 'job', total: 0, records: [], filtersApplied: filters };
    if (ids.length === 1) jobId = String(ids[0]); else jobIds = ids.map(String);
  }

  // A user id means that person's own candidate profiles, exactly. Searching by their name instead also hit
  // namesakes and every job whose title contains the name; a profile a recruiter merely owns is not theirs.
  let candidateIds = null;
  if (filters.applicantUserId && !filters.applicantName) {
    if (!mongoose.Types.ObjectId.isValid(filters.applicantUserId)) {
      return { notFound: 'applicant', total: 0, records: [], filtersApplied: filters };
    }
    const profiles = await deps.Employee.find({ owner: filters.applicantUserId }).select('owner email').lean();
    const owns = await ownsProfile(profiles, deps);
    candidateIds = profiles.filter(owns).map((p) => String(p._id));
    if (!candidateIds.length) return { notFound: 'applicant', total: 0, records: [], filtersApplied: filters };
  }

  const hasApplicant = !!(filters.applicantName || filters.applicantUserId);
  const res = await deps.searchApplications({
    q: filters.applicantName,
    userId: candidateIds ? null : filters.applicantUserId,
    candidateIds,
    status: filters.status,
    jobId,
    jobIds,
    user,
    limit,
    requireApplicantQ: hasApplicant,
  });
  if (res?.notFound) return { notFound: 'applicant', total: 0, records: [], filtersApplied: filters };
  return {
    total: res.total ?? 0,
    baseTotal: res.baseTotal ?? res.total ?? 0,
    breakdown: res.breakdown ?? null,
    records: (res.records || []).map((r) => ({
      id: String(r._id ?? r.id ?? ''),
      applicant: r.candidate?.fullName ?? r.applicantUser?.name ?? null,
      job: r.job?.title ?? null,
      status: r.status ?? null,
      appliedAt: r.createdAt ?? null,
    })),
    filtersApplied: filters,
  };
}

export function applicationCountFacts(kind, total) {
  const fact = { kind, label: 'applications', total };
  return { counts: [fact], primary: fact };
}
