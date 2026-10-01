import JobApplicationModel from '../../../../../models/jobApplication.model.js';
import CallRecordModel from '../../../../../models/callRecord.model.js';
import { buildApplicantQuery as realBuildApplicantQuery } from '../../../../applicantQuery.service.js';
import { CLOSED_APPLICATION_STATUSES } from '../../../../../constants/atsPipeline.js';
import { dayWindowBounds } from '../employees/common.js';

// Callback requests and never-called applicants live on JobApplication, not CallRecord.
// Row scope is the Applications page's (applicantQuery.service buildApplicantQuery: admin /
// interviews.manage / recruiter / sales agent / self, active candidates, no synthetic offer rows),
// and the viewer needs that page's permission as well as calls.view.
export const FOLLOWUP_KINDS = ['callbackRequested', 'callbackOverdue', 'notYetCalled'];
export const APPLICATIONS_PAGE_PERMISSION = 'candidates.read';

// The scheduler (applicationVerificationCall.scheduler runDueCallbacks) ticks every 2 minutes and
// unsets verificationCallbackAt when it dials, so a time a few minutes past is still "about to ring".
export const CALLBACK_GRACE_MS = 5 * 60 * 1000;

const OPEN = { status: { $nin: [...CLOSED_APPLICATION_STATUSES] }, verificationCallStatus: { $ne: 'withdrawn' } };

export function followupDeps(deps = {}) {
  return {
    buildApplicantQuery: deps.buildApplicantQuery ?? realBuildApplicantQuery,
    JobApplication: deps.JobApplication ?? JobApplicationModel,
    CallRecord: deps.CallRecord ?? CallRecordModel,
  };
}

const isEmptyScope = (q) => Array.isArray(q?._id?.$in) && q._id.$in.length === 0;

async function scopedApplications({ jobId, appliedBetween, applicantUserId }, user, deps) {
  const { from, to } = dayWindowBounds(appliedBetween);
  const filter = { excludeInternal: true };
  if (jobId) filter.jobId = jobId;
  if (from) filter.dateFrom = from;
  if (to) filter.dateTo = to;
  const { query } = await deps.buildApplicantQuery(filter, user);
  if (!applicantUserId) return query;
  return { $and: [query, { applicantUser: applicantUserId }] };
}

function toFollowupRow(app) {
  return {
    applicationId: String(app._id),
    applicant: app.candidate?.fullName ?? null,
    job: app.job?.title ?? null,
    applicationStatus: app.status ?? null,
    appliedAt: app.createdAt ?? null,
    callbackAt: app.verificationCallbackAt ?? null,
    callbacksBooked: app.verificationCallbackCount ?? 0,
    verificationCallStatus: app.verificationCallStatus ?? null,
  };
}

async function exampleRows(deps, filter, sort, limit) {
  if (!limit) return [];
  const apps = await deps.JobApplication.find(filter)
    .sort(sort)
    .limit(limit)
    .select('candidate job status createdAt verificationCallbackAt verificationCallbackCount verificationCallStatus')
    .populate({ path: 'candidate', select: 'fullName' })
    .populate({ path: 'job', select: 'title' })
    .lean();
  return apps.map(toFollowupRow);
}

async function callbacks(kind, scope, deps, limit, now) {
  const cutoff = new Date(now.getTime() - CALLBACK_GRACE_MS);
  const when = kind === 'callbackOverdue' ? { $lt: cutoff } : { $gte: cutoff };
  const filter = { $and: [scope, OPEN, { verificationCallbackAt: when }] };
  const [total, records] = await Promise.all([
    deps.JobApplication.countDocuments(filter),
    exampleRows(deps, filter, { verificationCallbackAt: 1 }, limit),
  ]);
  return { total, records };
}

/**
 * Open applications with no verification call id and no CallRecord for the same candidate + job.
 * Dialer calls carry no candidate/job link, so a candidate only ever rung from the dialer still
 * counts as not called.
 * ponytail: loads id-only rows for every open, never-dialled application in scope and the matching
 * CallRecord pairs. Fine for tens of thousands; past that move it into one $lookup aggregate
 * (and index CallRecord { candidate, job }).
 */
async function notYetCalled(scope, deps, limit) {
  const apps = await deps.JobApplication.find({
    $and: [scope, OPEN, { verificationCallExecutionId: { $in: [null, ''] } }],
  })
    .select('_id candidate job createdAt verificationCallStatus')
    .sort({ createdAt: -1 })
    .lean();
  if (!apps.length) return { total: 0, records: [], byVerificationStatus: {} };
  const called = await deps.CallRecord.find({
    candidate: { $in: [...new Set(apps.map((a) => String(a.candidate)))] },
    job: { $in: [...new Set(apps.map((a) => String(a.job)))] },
  })
    .select('candidate job')
    .lean();
  const calledPairs = new Set(called.map((c) => `${c.candidate}|${c.job}`));
  const uncalled = apps.filter((a) => !calledPairs.has(`${a.candidate}|${a.job}`));
  const byVerificationStatus = {};
  for (const a of uncalled) {
    const k = a.verificationCallStatus || 'never attempted';
    byVerificationStatus[k] = (byVerificationStatus[k] || 0) + 1;
  }
  const ids = uncalled.slice(0, limit).map((a) => a._id);
  const records = ids.length ? await exampleRows(deps, { _id: { $in: ids } }, { createdAt: -1 }, ids.length) : [];
  return { total: uncalled.length, records, byVerificationStatus };
}

/**
 * @param {'callbackRequested'|'callbackOverdue'|'notYetCalled'} kind
 * @param {{ jobId?: string, appliedBetween?: { from?: string, to?: string }, applicantUserId?: string }} filters
 * @returns {Promise<{ total: number, records: object[], byVerificationStatus?: object }>}
 */
export async function runFollowups(kind, filters, user, deps, { limit = 20, now = new Date() } = {}) {
  const scope = await scopedApplications(filters || {}, user, deps);
  if (isEmptyScope(scope)) return { total: 0, records: [] };
  if (kind === 'notYetCalled') return notYetCalled(scope, deps, limit);
  return callbacks(kind, scope, deps, limit, now);
}
