/**
 * Epic F — Training (LMS course progress) analytics helpers.
 *
 * SPIKE RESULT (documented per docs/superpowers/specs/2026-08-07-analytics-agent-core-design.md §8):
 *   - `StudentCourseProgress.student` → `Student._id` (studentCourseProgress.model.js)
 *   - `Student.user` → `User` (required, unique — one Student profile per User; student.model.js)
 *   - There is NO direct ATS Candidate/Employee foreign key on StudentCourseProgress.
 *   - The SAME User MAY also have an Employee profile (Employee.owner → User) — course
 *     assignments are made to `Student` documents only, never to `Employee`/Candidate docs.
 *
 * Consequence: this module implements training analytics for the STUDENT population
 * (any User who has a Student profile), NOT the ATS-candidate population. A chatbot
 * answer must NEVER claim "courses for ATS candidate X" unless a Student profile is
 * confirmed to exist for that same User — use `resolveStudentIdForUser` first and
 * treat a null result as "no Student profile / not enrolled", not "zero courses".
 */

import Student from '../../models/student.model.js';

/** Mirrors the `status` enum on studentCourseProgress.model.js. */
export const COURSE_PROGRESS_STATUSES = Object.freeze(['enrolled', 'in-progress', 'completed', 'dropped']);

/**
 * Resolve the `Student._id` for a given `User._id`, following the ONLY confirmed FK
 * path (`Student.user` → `User`). Returns `null` when the User has no Student
 * profile at all — callers MUST treat that as "not a student" and must NOT fall
 * back to searching by ATS Candidate/Employee id.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<string|null>}
 */
export async function resolveStudentIdForUser(userId) {
  if (!userId) return null;
  const student = await Student.findOne({ user: userId }).select('_id').lean();
  return student ? String(student._id) : null;
}

/**
 * Bulk variant of {@link resolveStudentIdForUser} — one query for N users.
 *
 * @param {Array<string|import('mongoose').Types.ObjectId>} userIds
 * @returns {Promise<Map<string, string>>} userId (string) → studentId (string)
 */
export async function resolveStudentIdsForUsers(userIds) {
  const ids = Array.isArray(userIds) ? userIds.filter(Boolean) : [];
  if (!ids.length) return new Map();
  const students = await Student.find({ user: { $in: ids } }).select('_id user').lean();
  const map = new Map();
  for (const s of students) {
    map.set(String(s.user), String(s._id));
  }
  return map;
}

/**
 * Build a Mongo filter for `StudentCourseProgress`, scoped to one (or more)
 * `Student._id` values — never an ATS Candidate/Employee id (there is no FK).
 *
 * @param {string|string[]} studentId - single Student._id or an array of them
 * @param {object} [opts]
 * @param {string} [opts.status] - enrolled | in-progress | completed | dropped
 * @param {string|import('mongoose').Types.ObjectId} [opts.module] - TrainingModule._id
 * @param {Date|null} [opts.from] - inclusive window start on enrolledAt
 * @param {Date|null} [opts.to] - inclusive window end on enrolledAt
 * @returns {object} mongo filter
 */
export function buildCourseProgressFilter(studentId, opts = {}) {
  const { status, module, from, to } = opts;
  const filter = {};

  if (Array.isArray(studentId)) {
    const ids = studentId.filter(Boolean);
    if (ids.length) filter.student = { $in: ids };
  } else if (studentId) {
    filter.student = studentId;
  }

  if (status && COURSE_PROGRESS_STATUSES.includes(status)) {
    filter.status = status;
  }

  if (module) {
    filter.module = module;
  }

  if (from || to) {
    filter.enrolledAt = {};
    if (from) filter.enrolledAt.$gte = from;
    if (to) filter.enrolledAt.$lte = to;
  }

  return filter;
}

/**
 * Zero-fill a status aggregation (`StudentCourseProgress.aggregate` `$group` on
 * `status`) into the canonical bucket set — pure, no DB.
 *
 * @param {Array<{ _id: string, count: number }>} statusAgg
 * @returns {{ total: number, byStatus: Record<string, number> }}
 */
export function summarizeCourseProgressBreakdown(statusAgg = []) {
  const byStatus = {};
  for (const s of COURSE_PROGRESS_STATUSES) byStatus[s] = 0;
  for (const row of statusAgg || []) {
    if (row?._id != null) byStatus[row._id] = Number(row.count || 0);
  }
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return { total, byStatus };
}
