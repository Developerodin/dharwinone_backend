import jwt from 'jsonwebtoken';
import httpStatus from 'http-status';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import JobApplication from '../models/jobApplication.model.js';
import Job from '../models/job.model.js';
import Employee from '../models/employee.model.js';
import { sendEmail } from './email.service.js';

const BOOKING_PURPOSE = 'interview_booking';

export const signBookingToken = (applicationId) =>
  jwt.sign({ sub: String(applicationId), purpose: BOOKING_PURPOSE }, config.jwt.secret, { expiresIn: '7d' });

/** Returns the applicationId inside a valid booking token; throws 410 otherwise (not 401 — the frontend treats 401 as an expired login and would try a session refresh). */
export const verifyBookingToken = (token) => {
  try {
    const payload = jwt.verify(String(token || ''), config.jwt.secret);
    if (payload?.purpose !== BOOKING_PURPOSE || !payload.sub) throw new Error('wrong purpose');
    return String(payload.sub);
  } catch {
    throw new ApiError(httpStatus.GONE, 'This booking link is invalid or has expired');
  }
};

export const bookingUrl = (applicationId) =>
  `${String(config.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '')}/book-interview/${signBookingToken(applicationId)}`;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Emails the candidate a fresh booking link. Resolves false when there is no one to email. */
export const sendBookingLinkEmail = async (applicationId) => {
  const application = await JobApplication.findById(applicationId).select('job candidate').lean();
  if (!application) return false;
  const [job, candidate] = await Promise.all([
    Job.findById(application.job).select('title').lean(),
    Employee.findById(application.candidate).select('fullName email').lean(),
  ]);
  if (!candidate?.email) {
    logger.warn(`[interviewBooking] no candidate email for application ${applicationId}; booking link not sent`);
    return false;
  }
  const url = bookingUrl(applicationId);
  const jobTitle = job?.title || 'the role';
  const name = candidate.fullName || 'there';
  const subject = `Choose your interview time — ${jobTitle}`;
  const text = `Hi ${name},\n\nThanks for your interest in ${jobTitle}. Please pick a time for your interview here:\n${url}\n\nThis link is valid for 7 days.`;
  const html = `<p>Hi ${escapeHtml(name)},</p><p>Thanks for your interest in <strong>${escapeHtml(
    jobTitle
  )}</strong>. Please pick a time for your interview:</p><p><a href="${escapeHtml(url)}">Choose an interview time</a></p><p>This link is valid for 7 days.</p>`;
  await sendEmail(candidate.email, subject, text, html, 'interview_booking_link', {
    applicationId: String(applicationId),
  });
  return true;
};

const TZ_LABELS = {
  'Asia/Kolkata': 'India time',
  'America/New_York': 'US Eastern time',
  'America/Chicago': 'US Central time',
  'America/Denver': 'US Mountain time',
  'America/Los_Angeles': 'US Pacific time',
  'Europe/London': 'UK time',
  'Australia/Sydney': 'Sydney time',
  'Asia/Dubai': 'Dubai time',
};

/** Human label for a timezone, e.g. "India time". Falls back to the city part of the IANA id. */
export const tzSpokenLabel = (tz) => {
  if (!tz) return 'India time';
  if (TZ_LABELS[tz]) return TZ_LABELS[tz];
  const city = String(tz).split('/').pop().replace(/_/g, ' ');
  return `${city} time`;
};

/** "Tuesday 30 September, 3 PM India time" — always in the given (candidate) tz. */
export const formatSpoken = (date, tz = 'Asia/Kolkata') => {
  const d = new Date(date);
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d)) {
    parts[p.type] = p.value;
  }
  const minute = parts.minute && parts.minute !== '00' ? `:${parts.minute}` : '';
  const ampm = String(parts.dayPeriod || '').toUpperCase();
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}${minute} ${ampm} ${tzSpokenLabel(tz)}`.replace(
    /\s+/g,
    ' '
  );
};

const PHONE_PREFIX_TZ = [
  ['+971', 'Asia/Dubai'],
  ['+91', 'Asia/Kolkata'],
  ['+44', 'Europe/London'],
  ['+61', 'Australia/Sydney'],
  ['+1', 'America/New_York'],
];

/** Best-effort tz from an E.164-ish phone number; confirmed with the candidate before use. */
export const guessCandidateTimezone = (phone) => {
  const p = String(phone || '').replace(/[\s\-()]/g, '');
  const normalized = p.startsWith('00') ? `+${p.slice(2)}` : p;
  const hit = PHONE_PREFIX_TZ.find(([prefix]) => normalized.startsWith(prefix));
  return hit ? hit[1] : 'Asia/Kolkata';
};
