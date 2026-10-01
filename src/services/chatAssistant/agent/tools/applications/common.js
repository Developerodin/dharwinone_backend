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
import { AGING_SCAN_LIMIT, applicationAge, keptForAging } from './aging.js';

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
    now: deps.now ?? (() => new Date()),
  };
}

function mapApplicationRow(r, now) {
  const age = applicationAge(r, now);
  return {
    id: String(r._id ?? r.id ?? ''),
    applicant: r.candidate?.fullName ?? r.applicantUser?.name ?? null,
    job: r.job?.title ?? null,
    status: r.status ?? null,
    appliedAt: r.createdAt ?? null,
    daysInStatus: age.daysInStatus,
    statusSince: age.statusSince,
    statusChangedAt: age.statusChangedAt,
    stageDateBasis: age.stageDateBasis,
    daysToScreening: age.daysToScreening,
    daysScreeningToInterview: age.daysScreeningToInterview,
    screening: age.screening,
  };
}

function statusBreakdown(rows) {
  const breakdown = {};
  for (const row of rows) {
    const status = row.status || 'Applied';
    breakdown[status] = (breakdown[status] || 0) + 1;
  }
  return breakdown;
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
  const aging = filters.inStatusOverDays != null || filters.screenedNeverInterviewed === true;
  let res;
  try {
    res = await deps.searchApplications({
      q: filters.applicantName,
      userId: candidateIds ? null : filters.applicantUserId,
      candidateIds,
      status: filters.status,
      jobId,
      jobIds,
      user,
      // Aging filters need the history on each row, which searchApplications already returns.
      // ponytail: capped at AGING_SCAN_LIMIT; a bigger cohort must move into the applicant query.
      limit: aging ? AGING_SCAN_LIMIT : limit,
      requireApplicantQ: hasApplicant,
    });
  } catch (err) {
    if (err?.statusCode === 403) {
      return { error: 'You do not have access to job applications.', total: 0, records: [], filtersApplied: filters };
    }
    throw err;
  }
  if (res?.notFound) return { notFound: 'applicant', total: 0, records: [], filtersApplied: filters };

  const now = deps.now();
  const loaded = res.records || [];
  if (!aging) {
    return {
      total: res.total ?? 0,
      baseTotal: res.baseTotal ?? res.total ?? 0,
      breakdown: res.breakdown ?? null,
      records: loaded.map((r) => mapApplicationRow(r, now)),
      filtersApplied: filters,
    };
  }

  const aged = loaded.map((r) => mapApplicationRow(r, now));
  const matched = aged.filter((row) => keptForAging(row, filters));
  const statusAgeUnknown = aged.filter((row) => row.daysInStatus == null).length;
  const screeningUnknown = aged.filter((row) => row.screening === 'unknown').length;
  const truncated = (res.total ?? 0) > loaded.length;
  return {
    total: matched.length,
    baseTotal: res.total ?? loaded.length,
    breakdown: statusBreakdown(matched),
    ...(filters.inStatusOverDays != null ? { statusAgeUnknown } : {}),
    ...(filters.screenedNeverInterviewed === true ? { screeningUnknown } : {}),
    ...(truncated ? { truncated: true, scanCap: AGING_SCAN_LIMIT } : {}),
    records: matched.slice(0, limit),
    filtersApplied: filters,
  };
}

export function applicationCountFacts(kind, total) {
  const fact = { kind, label: 'applications', total };
  return { counts: [fact], primary: fact };
}
