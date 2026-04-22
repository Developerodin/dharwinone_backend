import config from '../config/config.js';

/**
 * Build public meeting URL for a meetingId; optional name/email prefill for LiveKit join.
 * @param {string} meetingId
 * @param {{ name?: string, email?: string }} [invite]
 * @returns {string}
 */
export const getPublicMeetingUrl = (meetingId, invite = {}) => {
  const base = (config.frontendBaseUrl || '').replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('room', meetingId);
  const n = typeof invite.name === 'string' ? invite.name.trim() : '';
  const e = typeof invite.email === 'string' ? invite.email.trim() : '';
  if (n) params.set('name', n);
  if (e) params.set('email', e);
  const qs = params.toString();
  return base ? `${base}/join/room?${qs}` : `/join/room?${qs}`;
};
