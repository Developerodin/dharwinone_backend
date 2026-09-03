import httpStatus from 'http-status';
import CourseLearnerNote from '../models/courseLearnerNote.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import ApiError from '../utils/ApiError.js';

/**
 * Ensure student and module exist.
 * @param {string} studentId
 * @param {string} moduleId
 */
const ensureCourseContext = async (studentId, moduleId) => {
  const [student, module] = await Promise.all([
    Student.exists({ _id: studentId }),
    TrainingModule.exists({ _id: moduleId }),
  ]);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
};

/**
 * Get a learner note for a playlist item.
 * @param {string} studentId
 * @param {string} moduleId
 * @param {string} playlistItemId
 */
const getNote = async (studentId, moduleId, playlistItemId) => {
  await ensureCourseContext(studentId, moduleId);
  const note = await CourseLearnerNote.findOne({ student: studentId, module: moduleId, playlistItemId }).lean();
  return {
    playlistItemId,
    body: note?.body ?? '',
    updatedAt: note?.updatedAt ?? null,
    id: note?._id ? String(note._id) : null,
  };
};

/**
 * Upsert a learner note for a playlist item.
 * @param {string} studentId
 * @param {string} moduleId
 * @param {string} playlistItemId
 * @param {string} body
 */
const upsertNote = async (studentId, moduleId, playlistItemId, body) => {
  await ensureCourseContext(studentId, moduleId);
  const note = await CourseLearnerNote.findOneAndUpdate(
    { student: studentId, module: moduleId, playlistItemId },
    { $set: { body: body ?? '' } },
    { new: true, upsert: true, setDefaultsOnInsert: true, lean: true }
  );
  return {
    playlistItemId,
    body: note.body ?? '',
    updatedAt: note.updatedAt ?? null,
    id: String(note._id),
  };
};

export { getNote, upsertNote };
