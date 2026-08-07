/**
 * Epic D — Interview analytics helpers.
 *
 * Source of truth: `meeting.model.js` (the `Meeting` collection) — NOT
 * `internalMeeting.model.js`. Interviews are scheduled with `candidate`,
 * `recruiter`, `agents[]`, `interviewType`, `status` (lifecycle) and
 * `interviewResult` (outcome) embedded directly on the Meeting document.
 *
 * Person-name semantics (per docs/superpowers/specs Epic D):
 *  - "interviewer" / employee name  → `recruiter.name` OR any `agents[].name`
 *    (both are denormalized snapshots of the assigned staff, captured at
 *    schedule time — see meeting.model.js `agents` field comment).
 *  - "candidate"                    → `candidate.name` — a SEPARATE filter,
 *    never conflated with the interviewer.
 *  - "status"                       → Meeting lifecycle: scheduled | ended | cancelled.
 *  - "result" / "interviewResult"   → pending | selected | rejected.
 */

import { INTERVIEW_STATUSES, INTERVIEW_RESULTS } from '../../constants/atsPipeline.js';

/**
 * @param {string} value
 * @returns {string}
 */
function safeRegexFragment(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a Mongo filter for the `Meeting` collection (interviews).
 *
 * @param {object} opts
 * @param {Date|null} [opts.from] - inclusive window start
 * @param {Date|null} [opts.to] - inclusive window end
 * @param {'scheduledAt'|'createdAt'} [opts.dateField] - defaults to scheduledAt
 *   (prefer scheduledAt — that is the interview's actual calendar slot; createdAt
 *   is only when the row was filed).
 * @param {string} [opts.interviewerName] - matches recruiter.name OR any agents[].name
 * @param {string} [opts.candidateName] - matches candidate.name (separate from interviewer)
 * @param {string} [opts.status] - Meeting lifecycle: scheduled | ended | cancelled
 * @param {string} [opts.interviewResult] - pending | selected | rejected
 * @param {string|import('mongoose').Types.ObjectId} [opts.tenantId] - Meeting.tenantId scope
 * @param {string|import('mongoose').Types.ObjectId} [opts.createdBy] - Meeting.createdBy scope
 * @returns {object} mongo filter
 */
export function buildInterviewFilter(opts = {}) {
  const {
    from,
    to,
    dateField,
    interviewerName,
    candidateName,
    status,
    interviewResult,
    tenantId,
    createdBy,
  } = opts;

  const filter = {};

  const field = dateField === 'createdAt' ? 'createdAt' : 'scheduledAt';
  if (from || to) {
    filter[field] = {};
    if (from) filter[field].$gte = from;
    if (to) filter[field].$lte = to;
  }

  if (interviewerName && String(interviewerName).trim()) {
    const re = { $regex: safeRegexFragment(String(interviewerName).trim()), $options: 'i' };
    filter.$or = [{ 'recruiter.name': re }, { 'agents.name': re }];
  }

  if (candidateName && String(candidateName).trim()) {
    filter['candidate.name'] = {
      $regex: safeRegexFragment(String(candidateName).trim()),
      $options: 'i',
    };
  }

  if (status && INTERVIEW_STATUSES.includes(status)) {
    filter.status = status;
  }

  if (interviewResult && INTERVIEW_RESULTS.includes(interviewResult)) {
    filter.interviewResult = interviewResult;
  }

  if (tenantId) filter.tenantId = tenantId;
  if (createdBy) filter.createdBy = createdBy;

  return filter;
}

/**
 * Summarize interview status + result aggregation rows (from `Meeting.aggregate`
 * `$group` on `status` and `interviewResult` respectively) into a labeled,
 * zero-filled breakdown so the chatbot never has to infer a missing bucket = 0.
 *
 * @param {Array<{ _id: string, count: number }>} [statusAgg]
 * @param {Array<{ _id: string, count: number }>} [resultAgg]
 * @returns {{ total: number, byStatus: Record<string, number>, byResult: Record<string, number> }}
 */
export function summarizeInterviewBreakdown(statusAgg = [], resultAgg = []) {
  const byStatus = {};
  for (const s of INTERVIEW_STATUSES) byStatus[s] = 0;
  for (const row of statusAgg || []) {
    if (row?._id != null) byStatus[row._id] = Number(row.count || 0);
  }

  const byResult = {};
  for (const r of INTERVIEW_RESULTS) byResult[r] = 0;
  for (const row of resultAgg || []) {
    if (row?._id != null) {
      byResult[row._id] = Number(row.count || 0);
    }
  }

  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

  return { total, byStatus, byResult };
}
