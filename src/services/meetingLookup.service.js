import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import { getPublicMeetingUrl } from '../utils/meetingPublicUrl.js';

/**
 * Get meeting by meetingId (for public URL lookup and LiveKit host checks).
 * Lives in a small module so livekit.service does not import meeting.service (avoids import cycle).
 * @param {string} meetingId
 * @returns {Promise<Object|null>}
 */
export const getMeetingByMeetingId = async (meetingId) => {
  const meeting = await Meeting.findOne({ meetingId }).populate('createdBy');
  if (meeting) {
    const doc = meeting.toJSON();
    doc.publicMeetingUrl = getPublicMeetingUrl(meeting.meetingId);
    return doc;
  }
  const internal = await InternalMeeting.findOne({ meetingId }).populate('createdBy');
  if (!internal) return null;
  const doc = internal.toJSON();
  doc.publicMeetingUrl = getPublicMeetingUrl(internal.meetingId);
  doc.meetingKind = 'internal';
  return doc;
};

/**
 * Load the backing Mongo document for a LiveKit room (interview or communication meeting).
 * @param {string} meetingId
 * @returns {Promise<{ meeting: import('mongoose').Document, meetingKind: 'interview'|'internal' }|null>}
 */
export const findRoomMeetingDocument = async (meetingId) => {
  const trimmed = String(meetingId || '').trim();
  if (!trimmed) return null;
  const interview = await Meeting.findOne({ meetingId: trimmed });
  if (interview) {
    return { meeting: interview, meetingKind: 'interview' };
  }
  const internal = await InternalMeeting.findOne({ meetingId: trimmed });
  if (!internal) return null;
  return { meeting: internal, meetingKind: 'internal' };
};
