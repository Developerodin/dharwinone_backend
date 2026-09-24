import crypto from 'crypto';
import httpStatus from 'http-status';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import JobApplication from '../models/jobApplication.model.js';
import Job from '../models/job.model.js';
import User from '../models/user.model.js';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import InterviewHold from '../models/interviewHold.model.js';
import InterviewerAvailability from '../models/interviewerAvailability.model.js';
import { zonedWallTimeToUtc, dateStrInTz, dayOfWeekOfDateStr, addDaysToDateStr } from '../utils/zonedTime.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Longest meeting allowed (meeting.validation durationMinutes max) — widens the busy lookup window. */
const MAX_MEETING_MS = 480 * 60 * 1000;
const DEFAULT_DURATION = 60;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Slot length for this application. The round plan has no duration field yet, so always 60. */
export const durationFor = (_application) => DEFAULT_DURATION;

/**
 * Next unscheduled round from the application's frozen plan; none => off-plan screening.
 * Never returns an index: createMeeting allocates it.
 */
export const resolveRound = async (application) => {
  const rounds = application?.roundPlanSnapshot?.rounds || [];
  if (rounds.length) {
    const taken = await Meeting.find({
      applicationId: application._id,
      status: { $ne: 'cancelled' },
      'round.planKey': { $ne: null },
    })
      .select('round.planKey')
      .lean();
    const takenKeys = new Set(taken.map((m) => String(m.round?.planKey || '')));
    const row = rounds.find((r) => !takenKeys.has(r.key));
    if (row) return { index: null, type: row.roundType || null, label: row.label, planKey: row.key };
  }
  return { index: null, type: 'screening', label: 'Screening', planKey: null };
};

const slotSig = (applicationId, ms) =>
  crypto
    .createHmac('sha256', String(config.jwt.secret))
    .update(`${applicationId}:${ms}`)
    .digest('base64url')
    .slice(0, 10);

export const encodeSlotId = ({ applicationId, start }) => {
  const ms = new Date(start).getTime();
  return `${Buffer.from(String(ms)).toString('base64url')}.${slotSig(String(applicationId), ms)}`;
};

const appRefSig = (applicationId) =>
  crypto
    .createHmac('sha256', String(config.jwt.secret))
    .update(`ai-tool-app:${applicationId}`)
    .digest('base64url')
    .slice(0, 16);

/**
 * Signed application reference baked into ONE call's prompt (`<id>.<sig>`). The Bolna tools only
 * accept this, so a candidate who talks the agent into using another application's raw id gets
 * nothing — they never see a valid signature for any application but their own.
 */
export const signApplicationRef = (applicationId) => `${applicationId}.${appRefSig(String(applicationId))}`;

/** Returns the application id, or null when the ref is malformed or its signature is wrong. */
export const verifyApplicationRef = (ref) => {
  if (!ref || typeof ref !== 'string') return null;
  const [id, sig] = ref.split('.');
  if (!/^[a-f0-9]{24}$/i.test(id || '') || !sig) return null;
  const expected = appRefSig(id);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
};

/** Verifies the HMAC; returns the slot start Date or null when tampered/malformed. */
export const decodeSlotId = (slotId, applicationId) => {
  if (!slotId || typeof slotId !== 'string') return null;
  const [enc, sig] = slotId.split('.');
  if (!enc || !sig) return null;
  const ms = Number(Buffer.from(enc, 'base64url').toString());
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const expected = slotSig(String(applicationId), ms);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return new Date(ms);
};

/** Bookable windows of one availability doc between from..to, as UTC [start,end] ms pairs. */
const expandWindows = (avail, from, to) => {
  const tz = avail.timezone || 'Asia/Kolkata';
  const out = [];
  let dateStr = addDaysToDateStr(dateStrInTz(from, tz), -1);
  const lastDate = addDaysToDateStr(dateStrInTz(to, tz), 1);
  while (dateStr <= lastDate) {
    const day = dateStr;
    const override = (avail.overrides || []).find((o) => o.date === day);
    let windows;
    if (override?.blocked) windows = [];
    else if (override?.windows?.length) windows = override.windows;
    else {
      const dow = dayOfWeekOfDateStr(dateStr);
      windows = (avail.weekly || []).filter((w) => w.day === dow);
    }
    for (const w of windows) {
      const s = zonedWallTimeToUtc(dateStr, w.start, tz).getTime();
      const e = zonedWallTimeToUtc(dateStr, w.end, tz).getTime();
      if (e > s) out.push([s, e]);
    }
    dateStr = addDaysToDateStr(dateStr, 1);
  }
  return out;
};

/**
 * Busy intervals (UTC ms, unpadded) per interviewer id: scheduled interviews (host email,
 * case-insensitive, or assigned agent id), scheduled internal meetings they host, active holds.
 */
const loadBusy = async (users, from, to) => {
  const busy = new Map(users.map((u) => [String(u._id), []]));
  if (!users.length) return busy;
  const ids = users.map((u) => String(u._id));
  const emailToId = new Map(users.filter((u) => u.email).map((u) => [String(u.email).toLowerCase(), String(u._id)]));
  const emailRegexes = [...emailToId.keys()].map((e) => new RegExp(`^${escapeRegex(e)}$`, 'i'));
  const range = { $gte: new Date(from.getTime() - MAX_MEETING_MS - DAY), $lte: new Date(to.getTime() + DAY) };

  const push = (id, startMs, durMin) => {
    if (!busy.has(id)) return;
    busy.get(id).push([startMs, startMs + (Number(durMin) || DEFAULT_DURATION) * 60000]);
  };

  const [meetings, internalMeetings, holds] = await Promise.all([
    Meeting.find({
      status: 'scheduled',
      scheduledAt: range,
      $or: [...(emailRegexes.length ? [{ 'hosts.email': { $in: emailRegexes } }] : []), { 'agents.id': { $in: ids } }],
    })
      .select('scheduledAt durationMinutes hosts.email agents.id')
      .lean(),
    emailRegexes.length
      ? InternalMeeting.find({ status: 'scheduled', scheduledAt: range, 'hosts.email': { $in: emailRegexes } })
          .select('scheduledAt durationMinutes hosts.email')
          .lean()
      : [],
    InterviewHold.find({ active: true, interviewerId: { $in: ids }, start: range })
      .select('interviewerId start durationMinutes')
      .lean(),
  ]);

  for (const m of [...meetings, ...internalMeetings]) {
    const who = new Set();
    for (const h of m.hosts || []) {
      const id = emailToId.get(String(h.email || '').toLowerCase());
      if (id) who.add(id);
    }
    for (const a of m.agents || []) if (a?.id && busy.has(String(a.id))) who.add(String(a.id));
    for (const id of who) push(id, new Date(m.scheduledAt).getTime(), m.durationMinutes);
  }
  for (const h of holds) push(String(h.interviewerId), new Date(h.start).getTime(), h.durationMinutes);
  return busy;
};

/**
 * Free slot starts across interviewers: Map<startMs, interviewerId[]>.
 * ponytail: live compute — fine for <~20 pool members x 7 days (5 queries + in-memory loops).
 * Beyond that, precompute free slots per interviewer when availability/meetings change.
 */
const computeFreeSlotMap = async ({ interviewerIds, from, to, durationMinutes, onlyStartMs = null }) => {
  const result = new Map();
  if (!interviewerIds?.length) return result;
  const [availabilities, users] = await Promise.all([
    InterviewerAvailability.find({ user: { $in: interviewerIds } }).lean(),
    User.find({ _id: { $in: interviewerIds } }).select('email name').lean(),
  ]);
  // No availability set (or empty) => not bookable.
  const usable = availabilities.filter(
    (a) => (a.weekly || []).length || (a.overrides || []).some((o) => !o.blocked && o.windows?.length)
  );
  if (!usable.length) return result;
  const usableIds = new Set(usable.map((a) => String(a.user)));
  const busy = await loadBusy(
    users.filter((u) => usableIds.has(String(u._id))),
    from,
    to
  );
  const durMs = durationMinutes * 60000;

  for (const avail of usable) {
    const id = String(avail.user);
    const pad = (Number(avail.bufferMinutes ?? 15) || 0) * 60000;
    const intervals = (busy.get(id) || []).map(([s, e]) => [s - pad, e + pad]);
    for (const [ws, we] of expandWindows(avail, from, to)) {
      for (let t = ws; t + durMs <= we; t += durMs) {
        if (onlyStartMs != null && t !== onlyStartMs) continue;
        if (t < from.getTime() || t + durMs > to.getTime()) continue;
        if (intervals.some(([bs, be]) => t < be && t + durMs > bs)) continue;
        if (!result.has(t)) result.set(t, []);
        if (!result.get(t).includes(id)) result.get(t).push(id);
      }
    }
  }
  return result;
};

/** Interviewer ids (strings) from `interviewerIds` free for exactly [start, start+duration). */
export const findFreeInterviewersAt = async ({ interviewerIds, start, durationMinutes }) => {
  const s = new Date(start);
  const map = await computeFreeSlotMap({
    interviewerIds,
    from: s,
    to: new Date(s.getTime() + durationMinutes * 60000),
    durationMinutes,
    onlyStartMs: s.getTime(),
  });
  return map.get(s.getTime()) || [];
};

export const loadApplicationContext = async (applicationId) => {
  const application = await JobApplication.findById(applicationId)
    .select('job candidate status verificationCallStatus roundPlanSnapshot')
    .lean();
  if (!application) throw new ApiError(httpStatus.NOT_FOUND, 'Application not found');
  const job = await Job.findById(application.job).select('title interviewerPool createdBy').lean();
  if (!job) throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  return { application, job };
};

/**
 * Up to `limit` free slots across the job's interviewer pool, preferring distinct days
 * (days counted in `tz`, the candidate's zone) — first slot per day, then fill in time order.
 * @returns {Promise<Array<{start: Date, end: Date, interviewerIds: string[]}>>}
 */
export const getFreeSlots = async ({ applicationId, from, to, limit = 3, tz = 'Asia/Kolkata' } = {}) => {
  const now = Date.now();
  const fromD = from ? new Date(from) : new Date(now + 4 * HOUR);
  const toD = to ? new Date(to) : new Date(now + 7 * DAY);
  const { application, job } = await loadApplicationContext(applicationId);
  const pool = (job.interviewerPool || []).map(String);
  if (!pool.length) return [];
  const durationMinutes = durationFor(application);
  const map = await computeFreeSlotMap({ interviewerIds: pool, from: fromD, to: toD, durationMinutes });
  const starts = [...map.keys()].sort((a, b) => a - b);

  const picked = [];
  const seenDays = new Set();
  for (const t of starts) {
    if (picked.length >= limit) break;
    const day = dateStrInTz(new Date(t), tz);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    picked.push(t);
  }
  for (const t of starts) {
    if (picked.length >= limit) break;
    if (!picked.includes(t)) picked.push(t);
  }
  picked.sort((a, b) => a - b);
  return picked.map((t) => ({
    start: new Date(t),
    end: new Date(t + durationMinutes * 60000),
    interviewerIds: map.get(t),
  }));
};
