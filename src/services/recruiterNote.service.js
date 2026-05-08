import httpStatus from 'http-status';
import RecruiterNote from '../models/recruiterNote.model.js';
import User from '../models/user.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const ensureRecruiterExists = async (recruiterId) => {
  const exists = await User.exists({ _id: recruiterId });
  if (!exists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recruiter not found');
  }
};

const listForRecruiter = async (recruiterId, requesterUser) => {
  await ensureRecruiterExists(recruiterId);
  const isAdmin = await userIsAdmin(requesterUser);
  const visibilityClause = isAdmin
    ? {}
    : { $or: [{ visibility: 'public' }, { postedBy: requesterUser._id }] };
  const notes = await RecruiterNote.find({ recruiter: recruiterId, ...visibilityClause })
    .sort({ createdAt: -1 })
    .lean();
  return notes;
};

const createNote = async (recruiterId, requesterUser, payload) => {
  await ensureRecruiterExists(recruiterId);
  const note = await RecruiterNote.create({
    recruiter: recruiterId,
    note: payload.note,
    visibility: payload.visibility || 'public',
    postedBy: requesterUser._id,
    postedByName: requesterUser.name || requesterUser.email || 'Unknown',
  });
  return note.toObject();
};

const deleteNote = async (noteId, requesterUser) => {
  const note = await RecruiterNote.findById(noteId);
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

export { listForRecruiter, createNote, deleteNote };
