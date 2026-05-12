import httpStatus from 'http-status';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import ChatCall from '../models/chatCall.model.js';
import ApiError from '../utils/ApiError.js';

function lc(s) {
  return String(s || '').toLowerCase().trim();
}

export function isAllowedByMeeting(meeting, user) {
  if (!meeting) return false;
  if (user?.role === 'admin' || user?.isAdmin) return true;
  const emailLower = lc(user?.email);
  if (!emailLower) return false;
  const allowed = new Set();
  (meeting.hosts || []).forEach((h) => h?.email && allowed.add(lc(h.email)));
  (meeting.emailInvites || []).forEach((e) => allowed.add(lc(e)));
  if (meeting.candidate?.email) allowed.add(lc(meeting.candidate.email));
  if (meeting.recruiter?.email) allowed.add(lc(meeting.recruiter.email));
  return allowed.has(emailLower);
}

export function isAllowedByInternalMeeting(meeting, user) {
  if (!meeting) return false;
  if (user?.role === 'admin' || user?.isAdmin) return true;
  const userId = String(user?._id || '');
  if (String(meeting.createdBy || '') === userId) return true;
  return (meeting.participants || []).some((p) => String(p.userId || p) === userId);
}

export function isAllowedByChatCall(chatCall, user) {
  if (!chatCall) return false;
  if (user?.role === 'admin' || user?.isAdmin) return true;
  const userId = String(user?._id || '');
  return String(chatCall.caller || '') === userId || String(chatCall.callee || '') === userId;
}

export async function authorizeMeetingAccess(user, meetingId) {
  if (!user) throw new ApiError(httpStatus.UNAUTHORIZED, 'auth required');

  const meeting = await Meeting.findOne({ meetingId }).lean();
  if (meeting && isAllowedByMeeting(meeting, user)) return { type: 'meeting', doc: meeting };

  const internal = await InternalMeeting.findOne({ meetingId }).lean();
  if (internal && isAllowedByInternalMeeting(internal, user)) {
    return { type: 'internalMeeting', doc: internal };
  }

  const chatCall = await ChatCall.findOne({ livekitRoom: meetingId }).lean();
  if (chatCall && isAllowedByChatCall(chatCall, user)) return { type: 'chatCall', doc: chatCall };

  throw new ApiError(httpStatus.FORBIDDEN, 'not authorized for this meeting');
}
