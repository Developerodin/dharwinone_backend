import httpStatus from 'http-status';
import RecruiterNote from '../models/recruiterNote.model.js';
import User from '../models/user.model.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { sendEmail, buildEmailHTML, buildPlainTextEmail } from './email.service.js';
import { getFrontendBaseUrl } from '../utils/emailLinks.js';

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

/**
 * Share recruiter profile via email. Sends a branded email containing recruiter
 * details (name, education, location, domain, profile summary) and a link to
 * the recruiter edit page, using the same mailer/template wrapper as the rest
 * of the backend.
 *
 * @param {string} recruiterId
 * @param {{ email: string, message?: string }} payload
 * @param {Object} requesterUser
 */
const shareRecruiterByEmail = async (recruiterId, payload, requesterUser) => {
  const recruiter = await User.findById(recruiterId).select(
    'name email education location domain profileSummary'
  );
  if (!recruiter) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recruiter not found');
  }

  const { email, message } = payload;
  const sharedBy = requesterUser?.name || requesterUser?.email || 'A Dharwin user';

  const frontendBase = (process.env.WEB_URL || getFrontendBaseUrl()).replace(/\/$/, '');
  const profileUrl = `${frontendBase}/ats/recruiters/edit/${recruiterId}`;

  const domainText = Array.isArray(recruiter.domain)
    ? recruiter.domain.filter(Boolean).join(', ')
    : recruiter.domain || '';

  const subject = 'Recruiter profile shared with you';
  const introLines = [
    `${sharedBy} shared a recruiter profile with you.`,
    'Review the recruiter details below and use the button to open their profile.',
  ];
  const detailRows = [
    { label: 'Recruiter', value: recruiter.name || '' },
    { label: 'Email', value: recruiter.email || '' },
    { label: 'Education', value: recruiter.education || '' },
    { label: 'Location', value: recruiter.location || '' },
    { label: 'Domain', value: domainText },
  ];
  const sections = [];
  if (recruiter.profileSummary && String(recruiter.profileSummary).trim()) {
    sections.push({
      title: 'Profile summary',
      tone: 'neutral',
      bodyLines: [String(recruiter.profileSummary).trim()],
    });
  }
  if (message && String(message).trim()) {
    sections.push({
      title: `Message from ${sharedBy}`,
      tone: 'info',
      bodyLines: [String(message).trim()],
    });
  }
  const primaryAction = { label: 'View recruiter profile', href: profileUrl };

  const text = buildPlainTextEmail({
    title: subject,
    greeting: 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
  });
  const html = buildEmailHTML({
    badgeText: 'Recruiter share',
    title: subject,
    greeting: 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
    preheader: `${sharedBy} shared ${recruiter.name || 'a recruiter'}'s profile with you.`,
  });

  await sendEmail(email, subject, text, html, 'recruiterProfileShare', {
    recruiterId: String(recruiterId),
    sharedBy,
    hasMessage: !!(message && String(message).trim()),
  });

  return { success: true, profileUrl };
};

export { listForRecruiter, createNote, deleteNote, shareRecruiterByEmail };
