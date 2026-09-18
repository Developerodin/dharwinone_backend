import { getPublicMeetingUrl } from '../utils/meetingPublicUrl.js';

/**
 * Candidate-safe meeting row for my-applications and my-interviews.
 */
export const serializeCandidateInterviewMeeting = (meeting) => {
  const m = meeting && typeof meeting.toJSON === 'function' ? meeting.toJSON() : meeting || {};
  const meetingId = m.meetingId || '';
  return {
    id: String(m.id || m._id || ''),
    meetingId,
    title: m.title || '',
    scheduledAt: m.scheduledAt,
    timezone: m.timezone || 'UTC',
    durationMinutes: Number(m.durationMinutes) > 0 ? Number(m.durationMinutes) : 60,
    status: m.status,
    interviewResult: m.interviewResult ?? null,
    interviewType: m.interviewType || 'Video',
    requireApproval: Boolean(m.requireApproval),
    round: m.round ?? null,
    notes: typeof m.notes === 'string' ? m.notes : '',
    interviewCompletedAt: m.interviewCompletedAt ?? null,
    applicationId: m.applicationId ? String(m.applicationId) : null,
    publicMeetingUrl: getPublicMeetingUrl(meetingId),
  };
};
