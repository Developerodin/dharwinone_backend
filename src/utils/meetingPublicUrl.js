import config from '../config/config.js';

/**
 * @param {string} meetingId
 * @param {{ name?: string, email?: string }} [invite]
 * @returns {string} query string (no leading ?)
 */
export const buildMeetingJoinQuery = (meetingId, invite = {}) => {
  const params = new URLSearchParams();
  params.set('room', meetingId);
  const n = typeof invite.name === 'string' ? invite.name.trim() : '';
  const e = typeof invite.email === 'string' ? invite.email.trim() : '';
  if (n) params.set('name', n);
  if (e) params.set('email', e);
  return params.toString();
};

/**
 * Relative in-app route for notification bell / toast navigation (always path-only).
 * @param {string} meetingId
 * @param {{ name?: string, email?: string }} [invite]
 * @returns {string}
 */
export const getInAppMeetingLink = (meetingId, invite = {}) => {
  const qs = buildMeetingJoinQuery(meetingId, invite);
  return `/join/room?${qs}`;
};

/**
 * Build public meeting URL for a meetingId; optional name/email prefill for LiveKit join.
 * Use for emails and external share links — not for in-app notification `link`.
 * @param {string} meetingId
 * @param {{ name?: string, email?: string }} [invite]
 * @returns {string}
 */
export const getPublicMeetingUrl = (meetingId, invite = {}) => {
  const base = (config.frontendBaseUrl || '').replace(/\/$/, '');
  const qs = buildMeetingJoinQuery(meetingId, invite);
  return base ? `${base}/join/room?${qs}` : `/join/room?${qs}`;
};
