import mongoose from 'mongoose';
import Student from '../models/student.model.js';

/**
 * The position-to-student edge lives here and nowhere else. The module employee
 * dropdown and bulk enrolment both call it, so the two can never drift apart
 * the way the roster and the dropdown did.
 */

/**
 * @param {string[]} positionIds
 * @returns {Promise<string[]>} deduped active Student ids as strings
 */
export const resolveStudentIdsForPositions = async (positionIds) => {
  const ids = (positionIds ?? []).map((id) => String(id)).filter(Boolean);
  if (!ids.length) return [];
  const students = await Student.find({ position: { $in: ids }, status: 'active' })
    .select('_id')
    .lean();
  return [...new Set(students.map((s) => String(s._id)))];
};

/**
 * @param {string[]} positionIds
 * @returns {Promise<Record<string, number>>} positionId to active student count
 */
export const countStudentsByPosition = async (positionIds) => {
  const ids = (positionIds ?? []).map((id) => String(id)).filter(Boolean);
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  const rows = await Student.aggregate([
    {
      $match: {
        position: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
        status: 'active',
      },
    },
    { $group: { _id: '$position', n: { $sum: 1 } } },
  ]);
  for (const row of rows) counts[String(row._id)] = row.n;
  return counts;
};
