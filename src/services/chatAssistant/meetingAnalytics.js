/**
 * Epic E — Internal / general meeting analytics helpers (non-interview).
 *
 * Source of truth: `internalMeeting.model.js` (the `InternalMeeting` collection).
 * Quick internal / team meetings (Communication module) are a DISTINCT population
 * from ATS interviews. Interviews live in the `Meeting` collection
 * (see interviewAnalytics.js, meeting.model.js) — this module must NEVER query
 * `Meeting`, and interviewAnalytics.js must never query `InternalMeeting`. Keeping
 * the two paths separate is what stops "meetings on Monday" from silently
 * returning only interviews (or vice versa) — see docs/superpowers/specs
 * 2026-08-07-analytics-agent-core-design.md §7.
 */

import InternalMeeting from '../../models/internalMeeting.model.js';

const INTERNAL_MEETING_STATUSES = ['scheduled', 'ended', 'cancelled'];
const INTERNAL_MEETING_TYPES = ['Video', 'In-Person', 'Phone'];

function safeRegexFragment(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a Mongo filter for the `InternalMeeting` collection.
 *
 * @param {object} opts
 * @param {Date|null} [opts.from] - inclusive window start (scheduledAt)
 * @param {Date|null} [opts.to] - inclusive window end (scheduledAt)
 * @param {string} [opts.participantEmail] - matches hosts.email OR emailInvites
 * @param {string} [opts.participantName] - matches hosts.nameOrRole (denormalized display name)
 * @param {string} [opts.status] - scheduled | ended | cancelled
 * @param {string} [opts.meetingType] - Video | In-Person | Phone
 * @param {string|import('mongoose').Types.ObjectId} [opts.createdBy] - scope to a company's users
 * @returns {object} mongo filter
 */
export function buildInternalMeetingFilter(opts = {}) {
  const {
    from,
    to,
    participantEmail,
    participantName,
    status,
    meetingType,
    createdBy,
  } = opts;

  const filter = {};

  if (from || to) {
    filter.scheduledAt = {};
    if (from) filter.scheduledAt.$gte = from;
    if (to) filter.scheduledAt.$lte = to;
  }

  const participantClauses = [];
  if (participantEmail && String(participantEmail).trim()) {
    const email = String(participantEmail).trim();
    participantClauses.push({ 'hosts.email': email }, { emailInvites: email });
  }
  if (participantName && String(participantName).trim()) {
    const re = { $regex: safeRegexFragment(String(participantName).trim()), $options: 'i' };
    participantClauses.push({ 'hosts.nameOrRole': re });
  }
  if (participantClauses.length) {
    filter.$or = participantClauses;
  }

  if (status && INTERNAL_MEETING_STATUSES.includes(status)) {
    filter.status = status;
  }

  if (meetingType && INTERNAL_MEETING_TYPES.includes(meetingType)) {
    filter.meetingType = meetingType;
  }

  if (createdBy) {
    if (Array.isArray(createdBy)) filter.createdBy = { $in: createdBy };
    else filter.createdBy = createdBy;
  }

  return filter;
}

/**
 * Count InternalMeeting rows per status, using the same filter shape as the list
 * query (minus the status filter itself, so every bucket is populated).
 *
 * @param {object} filterWithoutStatus - result of buildInternalMeetingFilter without `status`
 * @returns {Promise<Record<string, number>>}
 */
export async function countInternalMeetingsByStatus(filterWithoutStatus = {}) {
  const rows = await InternalMeeting.aggregate([
    { $match: filterWithoutStatus },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return summarizeInternalMeetingStatusRows(rows);
}

/**
 * Zero-fill a status aggregation into the canonical bucket set. Pure — no DB.
 * @param {Array<{ _id: string, count: number }>} rows
 * @returns {Record<string, number>}
 */
export function summarizeInternalMeetingStatusRows(rows = []) {
  const byStatus = {};
  for (const s of INTERNAL_MEETING_STATUSES) byStatus[s] = 0;
  for (const row of rows || []) {
    if (row?._id != null) byStatus[row._id] = Number(row.count || 0);
  }
  return byStatus;
}

/**
 * Total count for a built filter (thin wrapper kept for readability at call sites).
 * @param {object} filter
 * @returns {Promise<number>}
 */
export async function countInternalMeetings(filter = {}) {
  return InternalMeeting.countDocuments(filter);
}
