import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { userIsAdmin as realUserIsAdmin } from '../../../../../utils/roleHelpers.js';
import InterviewerAvailabilityModel from '../../../../../models/interviewerAvailability.model.js';
import UserModel from '../../../../../models/user.model.js';
import MeetingModel from '../../../../../models/meeting.model.js';
import InternalMeetingModel from '../../../../../models/internalMeeting.model.js';
import InterviewHoldModel from '../../../../../models/interviewHold.model.js';
import { formatSpoken as realFormatSpoken } from '../../../../interviewBooking.service.js';
import { zonedWallTimeToUtc, dateStrInTz, dayOfWeekOfDateStr, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { dayWindowBounds } from '../employees/common.js';
import { hiringScope, isSelfReference } from './common.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Longest meeting (meeting.validation durationMinutes max) — same busy-window pad as interviewSlot.service. */
const MAX_MEETING_MS = 480 * 60 * 1000;
/** Slot length interviewSlot.service durationFor uses (the round plan has no duration). */
const SLOT_MINUTES = 60;
/** getFreeSlots will not offer a start inside this lead. */
const LEAD_MS = 4 * HOUR;
const MAX_SLOTS = 24;
const HEX_ID = /^[0-9a-fA-F]{24}$/;
const IST = 'Asia/Kolkata';
const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD, a whole IST day.');

// GET /interview-scheduling/availability/me → interview-availability.read (Administrator by name bypasses).
// GET /availability/:userId → interviews.manage (Administrator by name bypasses).
// GET /slots/preview → interviews.manage only (no name bypass) — enforced in execute, not here.
export const AVAILABILITY_ACCESS = Object.freeze({
  anyOf: ['interview-availability.read', 'interviews.manage'],
  adminByName: true,
});

const PREVIEW_RULE = Object.freeze({ anyOf: ['interviews.manage'] });

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function availabilityDeps(ctx) {
  const d = ctx?.deps || {};
  return {
    InterviewerAvailability: d.InterviewerAvailability ?? InterviewerAvailabilityModel,
    User: d.User ?? UserModel,
    Meeting: d.Meeting ?? MeetingModel,
    InternalMeeting: d.InternalMeeting ?? InternalMeetingModel,
    InterviewHold: d.InterviewHold ?? InterviewHoldModel,
    formatSpoken: d.formatSpoken ?? realFormatSpoken,
    isAdmin: d.isAdmin ?? realUserIsAdmin,
    now: d.now ?? (() => new Date()),
  };
}

function hasHours(avail) {
  if (!avail) return false;
  return (avail.weekly || []).length > 0
    || (avail.overrides || []).some((o) => !o.blocked && o.windows?.length);
}

/** Bookable windows of one availability doc, UTC [start, end] ms. Same rules as interviewSlot.service expandWindows. */
function expandWindows(avail, from, to) {
  const tz = avail.timezone || IST;
  const out = [];
  let dateStr = addDaysToDateStr(dateStrInTz(from, tz), -1);
  const lastDate = addDaysToDateStr(dateStrInTz(to, tz), 1);
  while (dateStr <= lastDate) {
    const day = dateStr;
    const override = (avail.overrides || []).find((o) => o.date === day);
    let windows;
    if (override?.blocked) windows = [];
    else if (override?.windows?.length) windows = override.windows;
    else windows = (avail.weekly || []).filter((w) => w.day === dayOfWeekOfDateStr(day));
    for (const w of windows) {
      const s = zonedWallTimeToUtc(day, w.start, tz).getTime();
      const e = zonedWallTimeToUtc(day, w.end, tz).getTime();
      if (e > s) out.push([s, e]);
    }
    dateStr = addDaysToDateStr(dateStr, 1);
  }
  return out;
}

/**
 * Busy intervals per interviewer. Lockstep with interviewSlot.service loadBusy / computeFreeSlotMap,
 * which are not exported. Upgrade: export that function and delete this copy.
 * ponytail: one pass over the window is fine for ≤8 interviewers × 7 days. Past that, precompute.
 */
async function computeFreeSlotMap({ interviewerIds, from, to, durationMinutes }, deps) {
  const result = new Map();
  if (!interviewerIds?.length) return result;
  const [availabilities, users] = await Promise.all([
    deps.InterviewerAvailability.find({ user: { $in: interviewerIds } }).lean(),
    deps.User.find({ _id: { $in: interviewerIds } }).select('email name').lean(),
  ]);
  const usable = (availabilities || []).filter(hasHours);
  if (!usable.length) return result;
  const usableIds = new Set(usable.map((a) => String(a.user)));
  const people = (users || []).filter((u) => usableIds.has(String(u._id ?? u.id)));
  const busy = new Map(people.map((u) => [String(u._id ?? u.id), []]));
  const emailToId = new Map(people.filter((u) => u.email).map((u) => [String(u.email).toLowerCase(), String(u._id ?? u.id)]));
  const emailRegexes = [...emailToId.keys()].map((e) => new RegExp(`^${escapeRegex(e)}$`, 'i'));
  const range = { $gte: new Date(from.getTime() - MAX_MEETING_MS - DAY), $lte: new Date(to.getTime() + DAY) };
  const ids = [...busy.keys()];
  const push = (id, startMs, durMin) => {
    if (!busy.has(id)) return;
    busy.get(id).push([startMs, startMs + (Number(durMin) || SLOT_MINUTES) * 60000]);
  };
  const [meetings, internalMeetings, holds] = await Promise.all([
    deps.Meeting.find({
      status: 'scheduled',
      scheduledAt: range,
      $or: [...(emailRegexes.length ? [{ 'hosts.email': { $in: emailRegexes } }] : []), { 'agents.id': { $in: ids } }],
    }).select('scheduledAt durationMinutes hosts.email agents.id').lean(),
    emailRegexes.length
      ? deps.InternalMeeting.find({ status: 'scheduled', scheduledAt: range, 'hosts.email': { $in: emailRegexes } })
        .select('scheduledAt durationMinutes hosts.email').lean()
      : [],
    deps.InterviewHold.find({ active: true, interviewerId: { $in: ids }, start: range })
      .select('interviewerId start durationMinutes').lean(),
  ]);
  for (const m of [...(meetings || []), ...(internalMeetings || [])]) {
    const who = new Set();
    for (const h of m.hosts || []) {
      const id = emailToId.get(String(h.email || '').toLowerCase());
      if (id) who.add(id);
    }
    for (const a of m.agents || []) if (a?.id && busy.has(String(a.id))) who.add(String(a.id));
    for (const id of who) push(id, new Date(m.scheduledAt).getTime(), m.durationMinutes);
  }
  for (const h of holds || []) push(String(h.interviewerId), new Date(h.start).getTime(), h.durationMinutes);

  const durMs = durationMinutes * 60000;
  for (const avail of usable) {
    const id = String(avail.user);
    const pad = (Number(avail.bufferMinutes ?? 15) || 0) * 60000;
    const intervals = (busy.get(id) || []).map(([s, e]) => [s - pad, e + pad]);
    for (const [ws, we] of expandWindows(avail, from, to)) {
      for (let t = ws; t + durMs <= we; t += durMs) {
        if (t < from.getTime() || t + durMs > to.getTime()) continue;
        if (intervals.some(([bs, be]) => t < be && t + durMs > bs)) continue;
        if (!result.has(t)) result.set(t, []);
        if (!result.get(t).includes(id)) result.get(t).push(id);
      }
    }
  }
  return result;
}

function presentSlot(startMs, interviewerIds, deps) {
  const start = new Date(startMs);
  const end = new Date(startMs + SLOT_MINUTES * 60000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    spoken: deps.formatSpoken(start, IST),
    interviewerIds,
  };
}

function capSlots(list) {
  if (list.length <= MAX_SLOTS) return { slots: list, truncated: false };
  return { slots: list.slice(0, MAX_SLOTS), truncated: true };
}

function resolveRange(window, now) {
  const bounds = dayWindowBounds(window);
  const lead = new Date(now.getTime() + LEAD_MS);
  let from;
  let to;
  if (!bounds.from && !bounds.to) {
    from = lead;
    to = new Date(now.getTime() + 7 * DAY);
  } else {
    from = bounds.from ? new Date(bounds.from) : lead;
    to = bounds.to
      ? new Date(bounds.to)
      : new Date((bounds.from ? new Date(bounds.from) : now).getTime() + 7 * DAY);
    if (from < lead) from = lead;
  }
  return { from, to, empty: from >= to };
}

async function resolveOne(token, viewer, deps) {
  if (isSelfReference(token, viewer)) {
    return { user: { id: String(viewer.id || viewer._id), name: viewer.name || 'You' } };
  }
  const raw = String(token || '').trim();
  if (HEX_ID.test(raw)) {
    const doc = await deps.User.findById(raw).select('name').lean();
    if (!doc) return { notFound: raw };
    return { user: { id: String(doc.id ?? doc._id ?? raw), name: doc.name ?? null } };
  }
  const hits = await deps.User.find({ name: { $regex: escapeRegex(raw), $options: 'i' } }).select('name').limit(8).lean();
  const exact = (hits || []).filter((u) => String(u.name || '').toLowerCase() === raw.toLowerCase());
  const pool = exact.length ? exact : (hits || []);
  if (!pool.length) return { notFound: raw };
  if (pool.length > 1) {
    return { matches: pool.map((u) => ({ id: String(u.id ?? u._id), name: u.name ?? null })) };
  }
  const u = pool[0];
  return { user: { id: String(u.id ?? u._id), name: u.name ?? null } };
}

function hoursOf(doc) {
  if (!doc) {
    return { timezone: IST, bufferMinutes: 15, weekly: [], overrides: [] };
  }
  return {
    timezone: doc.timezone || IST,
    bufferMinutes: doc.bufferMinutes ?? 15,
    weekly: doc.weekly || [],
    overrides: doc.overrides || [],
  };
}

export default defineTool({
  name: 'get_interviewer_availability',
  domain: 'hiring',
  kind: 'read',
  description:
    'When interviewers are free. Omit interviewers for your own stored hours (Settings → Interview Availability). ' +
    'Name one or more interviewers for their hours; with interviews.manage, also the open 60-minute slots in the ' +
    'window (existing interviews, internal meetings and active holds removed — the booking-page slot rules) and, ' +
    'for two or more, commonFree (times every one of them is free). Times are spoken in India time (IST). ' +
    'Someone with no hours set is not bookable — availabilitySet false, never guessed. Window defaults to the ' +
    'next 7 days, and nothing inside the next 4 hours is offered.',
  input: Joi.object({
    interviewers: Joi.array().items(Joi.string().trim().min(1).max(120)).min(1).max(8).unique()
      .description('Interviewer names, ids, or "me". Omit for your own availability.'),
    window: Joi.object({
      from: isoDay,
      to: isoDay,
    }).description('Inclusive IST days to check. Omit for the next 7 days, starting 4 hours from now.'),
  }),
  access: AVAILABILITY_ACCESS,
  async execute(args = {}, ctx) {
    const viewer = hiringScope(ctx);
    const deps = availabilityDeps(ctx);
    const selfId = String(viewer.id || viewer._id);
    const tokens = args.interviewers?.length ? args.interviewers : ['me'];
    const canPreview = (await checkAccessRule(PREVIEW_RULE, viewer)).ok;
    const asksOthers = tokens.some((t) => !isSelfReference(t, viewer));
    if (asksOthers && !canPreview) {
      const admin = viewer.platformSuperUser || await deps.isAdmin(viewer);
      if (!admin) {
        return {
          error: 'Other interviewers need interviews.manage, or an Administrator. You can ask for your own availability.',
        };
      }
    }

    const resolved = [];
    const ambiguous = [];
    const missing = [];
    for (const token of tokens) {
      // A name lookup is the availability page's user id, resolved here. Refused above before any lookup
      // when the viewer may not open another person's hours.
      const one = await resolveOne(token, viewer, deps);
      if (one.matches) ambiguous.push({ query: String(token), matches: one.matches });
      else if (one.notFound) missing.push(one.notFound);
      else resolved.push(one.user);
    }
    if (ambiguous.length) return { ambiguous };
    if (missing.length) return { notFound: missing };

    const unique = [];
    const seen = new Set();
    for (const u of resolved) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      unique.push(u);
    }

    const docs = await deps.InterviewerAvailability.find({ user: { $in: unique.map((u) => u.id) } }).lean();
    const byUser = new Map((docs || []).map((d) => [String(d.user), d]));
    const now = deps.now();
    const range = resolveRange(args.window, now);

    let slotMap = new Map();
    if (canPreview && !range.empty) {
      slotMap = await computeFreeSlotMap({
        interviewerIds: unique.map((u) => u.id),
        from: range.from,
        to: range.to,
        durationMinutes: SLOT_MINUTES,
      }, deps);
    }

    const people = unique.map((u) => {
      const doc = byUser.get(u.id) || null;
      const mine = [];
      if (canPreview) {
        for (const [t, ids] of slotMap) {
          if (ids.includes(u.id)) mine.push(presentSlot(t, ids, deps));
        }
        mine.sort((a, b) => a.start.localeCompare(b.start));
      }
      const capped = capSlots(mine);
      return {
        id: u.id,
        name: u.name,
        self: u.id === selfId,
        availabilitySet: hasHours(doc),
        ...hoursOf(doc),
        freeSlots: canPreview ? capped.slots : null,
        ...(canPreview && capped.truncated ? { freeSlotsTruncated: true } : {}),
      };
    });

    let commonFree = null;
    let commonFreeTruncated = false;
    if (canPreview && unique.length >= 2) {
      const wanted = unique.map((u) => u.id);
      const common = [];
      for (const [t, ids] of [...slotMap.entries()].sort((a, b) => a[0] - b[0])) {
        if (wanted.every((id) => ids.includes(id))) common.push(presentSlot(t, ids, deps));
      }
      const capped = capSlots(common);
      commonFree = capped.slots;
      commonFreeTruncated = capped.truncated;
    }

    return {
      displayTimezone: IST,
      slotMinutes: canPreview ? SLOT_MINUTES : null,
      leadHours: canPreview ? 4 : null,
      window: { from: range.from.toISOString(), to: range.to.toISOString() },
      interviewers: people,
      commonFree,
      ...(commonFreeTruncated ? { commonFreeTruncated: true } : {}),
      ...(unique.length < 2 ? { commonFreeNote: 'Common free time needs at least two interviewers.' } : {}),
      ...(canPreview ? {} : {
        freeSlotsNote: 'Open slots (hours minus existing interviews) need interviews.manage. These are the stored weekly hours only.',
      }),
    };
  },
  render(result) {
    if (!result || result.error || result.ambiguous || result.notFound) return null;
    const rows = result.commonFree?.length
      ? result.commonFree
      : (result.interviewers || []).flatMap((p) => p.freeSlots || []);
    if (!rows.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'interviewer-free',
        title: result.commonFree ? 'Common free time (IST)' : 'Free slots (IST)',
        columns: [{ key: 'spoken', label: 'When', priority: 'primary' }],
        rows: rows.slice(0, 12).map((r) => ({ spoken: r.spoken })),
      }],
    };
  },
});
