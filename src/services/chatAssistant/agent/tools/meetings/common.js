import Joi from 'joi';
import {
  queryInternalMeetings as realQueryInternalMeetings,
  getInternalMeetingById as realGetInternalMeetingById,
} from '../../../../internalMeeting.service.js';
import recordingService from '../../../../recording.service.js';
import Summary from '../../../../../models/summary.model.js';
import Recording from '../../../../../models/recording.model.js';
import { ONBOARDING_ORIENTATION_MEETING_PERMS } from '../../../../../config/permissions.js';
import { buildInternalMeetingsMongoFilter } from '../../../../../utils/internalMeetingQueryFilter.js';
import { dateStrInTz } from '../../../../../utils/zonedTime.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dayRange, dayWindowBounds } from '../employees/common.js';

// GET /internal-meetings is auth-only: internalMeetingScope is the real gate
// (all four meetings.* = every meeting; otherwise created / hosting / invited).
export const MEETINGS_ACCESS = Object.freeze({ note: 'internalMeeting.service internalMeetingScope (all or own/invited)' });
// GET /internal-meetings/:id and /:id/recordings (canReadInternalMeeting); the service still applies
// internalMeetingScope on top, so a view-only user reaches only their own / invited meetings.
export const MEETING_DETAIL_ACCESS = Object.freeze({ anyOf: ['meetings.read', ...ONBOARDING_ORIENTATION_MEETING_PERMS] });
export const MAX_LIST_LIMIT = 50;
export const DEFAULT_LIST_LIMIT = 20;
export const MEETING_STATUSES = ['scheduled', 'ended', 'cancelled'];
export const NOT_CAPTURED = 'not captured in DharwinOne';

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.'); // format checked by dayRange

export const meetingFilters = Joi.object({
  search: Joi.string().min(1).max(200)
    .description('Free text matched against meeting title and host / invitee names — same as the Meetings page search box.'),
  status: Joi.string().valid(...MEETING_STATUSES)
    .description('Meeting lifecycle. "ended" = the host ended it OR its time slot passed (auto-ended), so it ' +
      'does not prove anyone joined — get_meeting attendees does. Omit for every status.'),
  when: Joi.string().valid('upcoming', 'past', 'earlier_today', 'any').default('any')
    .description('upcoming = starts from now on; past = already started; earlier_today = started today (IST) ' +
      'before now; any = both.'),
  scheduledBetween: Joi.object({ from: isoDay, to: isoDay })
    .description('Scheduled date window, inclusive whole days (IST).'),
  mine: Joi.boolean()
    .description('true = only meetings the viewer created, hosts or is invited to (the page\'s "Mine" toggle).'),
});

/** Fail closed without a user id: queryInternalMeetings skips the scope entirely when currentUser is null. */
export function meetingsScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('meeting tools need an authenticated user with an id');
  }
  return ctx.user;
}

export function meetingsDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    queryInternalMeetings: deps.queryInternalMeetings ?? realQueryInternalMeetings,
    getInternalMeetingById: deps.getInternalMeetingById ?? realGetInternalMeetingById,
    listRecordings: deps.listRecordings ?? recordingService.listByMeetingId,
    // Room ids (InternalMeeting.meetingId = Recording.meetingId) that have a playable recording.
    playableRecordingRooms: deps.playableRecordingRooms
      ?? ((rooms) => Recording.distinct('meetingId', { meetingId: { $in: rooms }, status: 'completed' })),
    findSummary: deps.findSummary ?? ((meetingId) => Summary.findOne({ meetingId }).lean()),
    checkAccess: deps.checkAccess ?? checkAccessRule,
    now: deps.now ?? (() => new Date()),
  };
}

/** Filters (minus status) → the page's Mongo filter + scheduledAt bounds. */
export function baseFilter(filters, now) {
  const { search, when = 'any', scheduledBetween } = filters || {};
  const filter = buildInternalMeetingsMongoFilter(search ? { search } : {});
  const and = filter.$and ? [...filter.$and] : [];
  const { scheduledFrom, scheduledTo } = dayRange('scheduled', scheduledBetween);
  const at = {};
  if (scheduledFrom) at.$gte = new Date(scheduledFrom);
  if (scheduledTo) at.$lte = new Date(scheduledTo);
  if (Object.keys(at).length) and.push({ scheduledAt: at });
  if (when === 'upcoming') and.push({ scheduledAt: { $gte: now } });
  if (when === 'past') and.push({ scheduledAt: { $lt: now } });
  if (when === 'earlier_today') {
    const today = dateStrInTz(now, DEFAULT_TIMEZONE);
    and.push({ scheduledAt: { $gte: new Date(dayWindowBounds({ from: today }).from), $lt: now } });
  }
  return and.length ? { $and: and } : {};
}

function withStatus(filter, status) {
  if (!status) return filter;
  return { $and: [...(filter.$and || []), { status }] };
}

/** Page-visible fields only: no description, no invite list (invitedCount instead). */
export function toRecord(m) {
  return {
    id: String(m.id ?? m._id ?? ''),
    title: m.title ?? null,
    scheduledAt: m.scheduledAt ?? null,
    timezone: m.timezone ?? null,
    durationMinutes: m.durationMinutes ?? null,
    meetingType: m.meetingType ?? null,
    status: m.status ?? null,
    hosts: (m.hosts || []).map((h) => h?.nameOrRole || h?.email).filter(Boolean),
    invitedCount: Array.isArray(m.emailInvites) ? m.emailInvites.length : 0,
    createdBy: m.createdBy?.name ?? null,
  };
}

/** Recordings the Meetings page row icon opens; only a `completed` one has a playable file. */
export const isPlayableRecording = (r) => r?.status === 'completed';

/** The /:id/recordings route gate; without it the row carries hasRecording null, never a guess. */
export async function canSeeRecordings(user, deps) {
  return (await deps.checkAccess(MEETING_DETAIL_ACCESS, user)).ok;
}

/**
 * hasRecording per row: ONE Recording lookup for the whole page ({ meetingId, status } index), keyed on
 * the rows' room ids — the same `completed` rows recording.service listByMeetingId returns as playable.
 * Rows are already inside internalMeetingScope, so this reveals nothing /:id/recordings would not.
 */
async function withRecordingFlags(rows, records, user, deps) {
  if (!records.length) return records;
  if (!(await canSeeRecordings(user, deps))) {
    return records.map((r) => ({ ...r, hasRecording: null }));
  }
  const rooms = rows.map((m) => m?.meetingId).filter(Boolean);
  let playable;
  try {
    playable = new Set((rooms.length ? await deps.playableRecordingRooms(rooms) : []).map(String));
  } catch {
    return records.map((r) => ({ ...r, hasRecording: null }));
  }
  return records.map((r, i) => ({ ...r, hasRecording: rows[i]?.meetingId ? playable.has(String(rows[i].meetingId)) : null }));
}

/**
 * Runs the Meetings page query (queryInternalMeetings, which ANDs internalMeetingScope).
 * Count mode returns a per-status breakdown too, and no rows. Ceiling: 4 paginated counts per
 * count call (each resolves the scope); fine at today's volumes — an aggregate in the service
 * is the upgrade if it ever shows up in latency.
 */
export async function runMeetingQuery({ filters = {}, limit, countOnly, user, deps }) {
  const now = deps.now();
  const base = baseFilter(filters, now);
  const scopeOptions = filters.mine ? { listScope: 'mine' } : {};
  const sortBy = filters.when === 'upcoming' ? 'scheduledAt' : '-scheduledAt';
  const run = (filter, lim) => deps.queryInternalMeetings(filter, { limit: lim, page: 1, sortBy }, user, scopeOptions);

  if (countOnly) {
    const [main, ...perStatus] = await Promise.all([
      run(withStatus(base, filters.status), 1),
      ...MEETING_STATUSES.map((s) => run(withStatus(base, s), 1)),
    ]);
    const breakdown = {};
    MEETING_STATUSES.forEach((s, i) => { breakdown[s] = perStatus[i]?.totalResults ?? 0; });
    return { total: main?.totalResults ?? 0, breakdown, filtersApplied: filters };
  }

  const res = await run(withStatus(base, filters.status), limit);
  const rows = res?.results || [];
  const records = await withRecordingFlags(rows, rows.map(toRecord), user, deps);
  return {
    total: res?.totalResults ?? 0,
    records,
    ...(records.some((r) => r.hasRecording === null)
      ? { recordingNote: 'hasRecording null = recordings need meetings.read, or the lookup failed.' }
      : {}),
    filtersApplied: filters,
  };
}

export function meetingCountFacts(kind, total) {
  const fact = { kind, label: 'meetings', total };
  return { counts: [fact], primary: fact };
}
