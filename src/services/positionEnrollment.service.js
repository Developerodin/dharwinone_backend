import mongoose from 'mongoose';
import Student from '../models/student.model.js';
import TrainingModule from '../models/trainingModule.model.js';

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

/**
 * Enrol or unenrol a position's students across several modules.
 * addToSet/pull are used deliberately: the old frontend path read the whole
 * students array and wrote it back, which loses concurrent writes. This never
 * reads the array.
 *
 * Note: one updateOne per module. At ~20 modules per position that is fine;
 * past a few hundred, switch to a single updateMany over moduleIds.
 */
export const bulkEnroll = async (positionId, { moduleIds, action, studentIds }) => {
  const targets = studentIds?.length
    ? studentIds.map(String)
    : await resolveStudentIdsForPositions([positionId]);
  if (!targets.length || !moduleIds?.length) return { enrolled: 0, skipped: 0, modules: [] };

  const update = action === 'remove'
    ? { $pull: { students: { $in: targets } } }
    : { $addToSet: { students: { $each: targets } } };

  const touched = [];
  for (const moduleId of moduleIds) {
    const res = await TrainingModule.updateOne({ _id: moduleId }, update);
    if (res.modifiedCount) touched.push(String(moduleId));
  }
  return {
    enrolled: touched.length * targets.length,
    skipped: (moduleIds.length - touched.length) * targets.length,
    modules: touched,
  };
};
