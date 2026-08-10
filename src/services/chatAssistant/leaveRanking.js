// uat.dharwin.backend/src/services/chatAssistant/leaveRanking.js
//
// Per-person leave ranking — "who took the most leave this month".
//
// This is a DIFFERENT question from both of its neighbours and deliberately
// lives in its own module so the three can never be conflated:
//   • who is on leave TODAY   -> onLeaveToday.service.js (Attendance ledger)
//   • the leave-request queue -> fetch_leave_requests    (LeaveRequest rows)
//   • who took the MOST leave -> here                    (LeaveRequest days per person)
//
// Ranking metric is leave DAYS inside the asked window, not request count: one
// five-day request outranks two one-day requests. Both numbers are returned so
// a caller can never mistake one for the other.
//
// Company scope is NOT decided here — the caller passes the filter produced by
// leaveRequest.service#buildLeaveRequestScopeFilter, the same scope the
// Settings → Leave Requests page uses.

const VALID_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];
const VALID_TYPES = ['casual', 'sick', 'unpaid'];

/** A leave/time-off mention — the subject has to actually be leave. */
const LEAVE_SUBJECT_RE = /\b(leaves?|time\s*off)\b/i;
/** Superlative or explicit ranking language. */
const RANK_CUE_RE = /\b(most|highest|top|maximum|max|fewest|least|lowest|rank|ranked|ranking|leader\s*board|leaderboard)\b/i;

/**
 * True when the question is asking who tops a leave comparison.
 *
 * Checked in detectIntent BEFORE the generic INTENT_PATTERNS list, because
 * "rank employees by leave taken" otherwise matches an employees rule and
 * "who has the most leaves" matches the catch-all leave rule — both of which
 * answer a different question than the one asked.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeLeaveRankingQuery(text) {
  if (!text || typeof text !== 'string') return false;
  return LEAVE_SUBJECT_RE.test(text) && RANK_CUE_RE.test(text);
}

/** Ranking counts leave actually granted unless the caller says otherwise. */
export const DEFAULT_RANKING_STATUS = 'approved';

/**
 * Normalize free-form tool args into the status/type/limit the pipeline takes.
 * @param {{ status?: string, leaveType?: string, limit?: number }} [args]
 * @returns {{ status: string|null, leaveType: string|null, limit: number }}
 *   status === null means "every status" (the caller explicitly asked for `all`).
 */
export function normalizeRankingArgs(args = {}) {
  const rawStatus = String(args.status ?? '').trim().toLowerCase();
  const status = rawStatus === 'all'
    ? null
    : (VALID_STATUS.includes(rawStatus) ? rawStatus : DEFAULT_RANKING_STATUS);

  const rawType = String(args.leaveType ?? '').trim().toLowerCase();
  const leaveType = VALID_TYPES.includes(rawType) ? rawType : null;

  const rawLimit = Number(args.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 10;

  return { status, leaveType, limit };
}

/**
 * Build the aggregation pipeline that ranks people by leave days in a window.
 *
 * @param {object} params
 * @param {object} params.companyFilter scope filter from buildLeaveRequestScopeFilter
 * @param {{ from: Date, to: Date }} params.window inclusive day window
 * @param {string|null} params.status
 * @param {string|null} params.leaveType
 * @param {number} params.limit
 * @returns {Array<object>} mongo aggregation pipeline
 */
export function buildLeaveRankingPipeline({ companyFilter, window, status, leaveType, limit }) {
  const match = { ...(companyFilter || {}) };
  // $elemMatch, not a bare range: both bounds must land on the SAME leave day,
  // otherwise a request spanning the window matches windows it never covers.
  match.dates = { $elemMatch: { $gte: window.from, $lte: window.to } };
  if (status) match.status = status;
  if (leaveType) match.leaveType = leaveType;

  return [
    { $match: match },
    // Credit only the days that actually fall inside the window — a request
    // running across two months must not charge its whole span to one of them.
    {
      $addFields: {
        daysInWindow: {
          $size: {
            $filter: {
              input: { $ifNull: ['$dates', []] },
              as: 'd',
              cond: { $and: [{ $gte: ['$$d', window.from] }, { $lte: ['$$d', window.to] }] },
            },
          },
        },
      },
    },
    { $match: { daysInWindow: { $gt: 0 } } },
    {
      $group: {
        _id: '$student',
        leaveDays: { $sum: '$daysInWindow' },
        requestCount: { $sum: 1 },
        leaveTypes: { $addToSet: '$leaveType' },
      },
    },
    { $sort: { leaveDays: -1, requestCount: -1, _id: 1 } },
    { $limit: limit },
    // Resolve the PERSON through Student -> User, never through requestedBy:
    // when an admin files on someone's behalf, requestedBy is the filer, not
    // the person whose leave it is.
    { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 'student' } },
    { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'users', localField: 'student.user', foreignField: '_id', as: 'owner' } },
    { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
    // Employee docs live in the `candidates` collection (see employee.model.js).
    { $lookup: { from: 'candidates', localField: 'student.user', foreignField: 'owner', as: 'employee' } },
    { $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        name: { $ifNull: ['$owner.name', { $ifNull: ['$employee.fullName', 'Unknown'] }] },
        email: '$owner.email',
        employeeId: '$employee.employeeId',
        leaveDays: 1,
        requestCount: 1,
        leaveTypes: 1,
      },
    },
  ];
}

/**
 * Attach 1-based ranks and tidy the leaveTypes sets.
 * @param {Array<object>} rows raw aggregation output
 * @returns {Array<object>}
 */
export function decorateRankedRows(rows) {
  return (rows || []).map((r, i) => ({
    rank: i + 1,
    ...r,
    leaveTypes: (r.leaveTypes || []).filter(Boolean).sort(),
  }));
}
