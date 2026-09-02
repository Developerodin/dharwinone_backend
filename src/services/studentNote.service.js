import httpStatus from 'http-status';
import Student from '../models/student.model.js';
import StudentNote from '../models/studentNote.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const ensureStudentExists = async (studentId) => {
  const exists = await Student.exists({ _id: studentId });
  if (!exists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
};

// .lean() / toObject() skip the toJSON plugin (and toJSON would strip createdAt).
const toClientNote = (n) => ({
  ...n,
  id: String(n._id),
  student: String(n.student),
  postedBy: n.postedBy != null ? String(n.postedBy) : n.postedBy,
});

const listForStudent = async (studentId, requesterUser) => {
  await ensureStudentExists(studentId);
  const isAdmin = await userIsAdmin(requesterUser);
  const visibilityClause = isAdmin
    ? {}
    : { $or: [{ visibility: 'public' }, { postedBy: requesterUser._id }] };
  const notes = await StudentNote.find({ student: studentId, ...visibilityClause })
    .sort({ createdAt: -1 })
    .lean();
  return notes.map(toClientNote);
};

const createNote = async (studentId, requesterUser, payload) => {
  await ensureStudentExists(studentId);
  const note = await StudentNote.create({
    student: studentId,
    note: payload.note,
    visibility: payload.visibility || 'public',
    postedBy: requesterUser._id,
    postedByName: requesterUser.name || requesterUser.email || 'Unknown',
  });
  return toClientNote(note.toObject());
};

const deleteNote = async (noteId, requesterUser) => {
  const note = await StudentNote.findById(noteId);
  if (!note) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Note not found');
  }
  const isAdmin = await userIsAdmin(requesterUser);
  if (!isAdmin && String(note.postedBy) !== String(requesterUser._id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only delete your own notes');
  }
  await note.deleteOne();
  return { id: noteId };
};

export { listForStudent, createNote, deleteNote };
