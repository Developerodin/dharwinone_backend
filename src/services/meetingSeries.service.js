import httpStatus from 'http-status';
import MeetingSeries from '../models/meetingSeries.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { deleteInterviewRoom } from './livekit.service.js';
import { getPublicMeetingUrl, getInAppMeetingLink } from '../utils/meetingPublicUrl.js';
import { normalizeTimezone } from '../utils/timezone.js';
import {
  generateOccurrences,
  recurrenceLabel,
  clampSeriesStartAt,
  seriesMaterializationFloor,
} from '../utils/recurrence.util.js';
import { sendMeetingInvitationEmail } from './email.service.js';
import { getInternalMeetingById } from './internalMeeting.service.js';

/**
 * Recurring meeting series. A MeetingSeries holds the recurrence rule + a shared
 * template; occurrences are materialized as InternalMeeting docs so all
 * join/LiveKit/recording/reminder logic is reused as-is. Occurrences become
 * visible (materialized + invited) only inside their lead window — 12h before
 * start for daily/back-to-back custom days, 24h for weekly/monthly/sparse
 * custom — so the list shows the current meeting and, at most, the imminent
 * next one. The scheduler tops series up as windows open ("End: Never" works).
 */

const HORIZON_DAYS = Math.max(7, Number(process.env.MEETING_SERIES_HORIZON_DAYS) || 90);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Lead time before the NEXT occurrence becomes visible (materialized + invited):
//   daily                          → 12h before start
//   weekly / monthly               → 24h before start
//   custom, consecutive-day gap    → 12h (behaves like daily)
//   custom, gap of a day or more   → 24h (behaves like weekly/monthly)
const DAILY_LEAD_MS = Math.max(1, Number(process.env.MEETING_SERIES_DAILY_LEAD_HOURS) || 12) * HOUR_MS;
const SPARSE_LEAD_MS = Math.max(1, Number(process.env.MEETING_SERIES_SPARSE_LEAD_HOURS) || 24) * HOUR_MS;
// "Consecutive days" tolerance: gaps up to 36h count as back-to-back days.
const CONSECUTIVE_GAP_MS = 36 * HOUR_MS;

/** Visibility lead for one occurrence, given the previous occurrence's time. */
const occurrenceLeadMs = (series, prevAt, at) => {
  const freq = series.recurrence?.frequency;
  if (freq === 'daily') return DAILY_LEAD_MS;
  if (freq === 'weekly' || freq === 'monthly') return SPARSE_LEAD_MS;
  // custom: derive from the gap to the previous occurrence
  if (prevAt && at.getTime() - prevAt.getTime() <= CONSECUTIVE_GAP_MS) return DAILY_LEAD_MS;
  return SPARSE_LEAD_MS;
};

// Template fields shared between a series and its occurrences (content, not timing).
const TEMPLATE_FIELDS = [
  'title',
  'description',
  'durationMinutes',
  'maxParticipants',
  'allowGuestJoin',
  'requireApproval',
  'meetingType',
  'hosts',
  'emailInvites',
  'notes',
];

const pickTemplate = (body = {}) => {
  const out = {};
  for (const k of TEMPLATE_FIELDS) if (k in body) out[k] = body[k];
  return out;
};

const getInvitationEmails = (src) => {
  const set = new Set();
  (src.hosts || []).forEach((h) => {
    if (h.email && String(h.email).trim()) set.add(String(h.email).trim().toLowerCase());
  });
  (src.emailInvites || []).forEach((e) => {
    if (e && String(e).trim()) set.add(String(e).trim().toLowerCase());
  });
  return [...set];
};

const resolveInviteeDisplayName = (src, emailAddress) => {
  if (!emailAddress || typeof emailAddress !== 'string') return 'Guest';
  const em = emailAddress.trim().toLowerCase();
  const host = (src.hosts || []).find((h) => h.email && String(h.email).trim().toLowerCase() === em);
  if (host?.nameOrRole && String(host.nameOrRole).trim()) return String(host.nameOrRole).trim();
  return em.split('@')[0] || 'Guest';
};

/** Resolve an occurrence by Mongo _id or by meetingId string. */
const resolveOccurrence = async (ref) => {
  if (!ref) return null;
  const s = String(ref).trim();
  if (/^[0-9a-fA-F]{24}$/.test(s)) return InternalMeeting.findById(s);
  return InternalMeeting.findOne({ meetingId: s });
};

const computeHorizon = (now) => new Date(now.getTime() + HORIZON_DAYS * DAY_MS);

/** Whether a bounded series has no occurrences beyond the horizon. */
const isFullyMaterialized = (series, occurrences, horizon) => {
  const end = series.end || {};
  if (end.mode === 'afterCount' && end.count) return occurrences.length >= end.count;
  if (end.mode === 'onDate' && end.untilDate) return new Date(end.untilDate).getTime() <= horizon.getTime();
  return false; // 'never' → always more
};

/** The occurrence template (fields copied onto each generated InternalMeeting). */
const occurrenceTemplate = (series) => ({
  title: series.title,
  description: series.description,
  timezone: series.timezone,
  durationMinutes: series.durationMinutes,
  maxParticipants: series.maxParticipants,
  allowGuestJoin: series.allowGuestJoin,
  requireApproval: series.requireApproval,
  meetingType: series.meetingType,
  hosts: series.hosts,
  emailInvites: series.emailInvites,
  notes: series.notes,
});

/** Whether an occurrence has entered its invite visibility window (12h / 24h lead). */
const isOccurrenceInviteDue = async (series, meeting, now = new Date()) => {
  const prev =
    meeting.occurrenceIndex > 0
      ? await InternalMeeting.findOne({
          seriesId: series._id,
          occurrenceIndex: meeting.occurrenceIndex - 1,
        })
          .select('scheduledAt')
          .lean()
      : null;
  const prevAt = prev?.scheduledAt ? new Date(prev.scheduledAt) : null;
  const at = new Date(meeting.scheduledAt);
  const visibleAt = new Date(at.getTime() - occurrenceLeadMs(series, prevAt, at));
  return visibleAt.getTime() <= now.getTime();
};

/**
 * Per-occurrence invite for the next visible meeting only (no recurring .ics — that
 * breaks Outlook delivery). Full send claims invitationSentAt once; partial sends
 * (new invitees on an already-invited occurrence) skip the claim.
 */
const sendOccurrenceInvites = async (series, meeting, { emails: onlyEmails } = {}) => {
  let recipients = getInvitationEmails(series);
  if (onlyEmails?.length) {
    const allow = new Set(onlyEmails.map((e) => String(e).trim().toLowerCase()));
    recipients = recipients.filter((e) => allow.has(e));
  }
  if (!recipients.length) return false;

  const meetingId = meeting._id || meeting.id;
  if (!onlyEmails?.length) {
    const alreadySent = await InternalMeeting.exists({ _id: meetingId, invitationSentAt: { $ne: null } });
    if (alreadySent) return false;
  }

  const hostName = series.hosts?.[0]?.nameOrRole || '';
  const scheduled = (() => {
    try {
      return new Date(meeting.scheduledAt).toLocaleString('en-US', { timeZone: normalizeTimezone(series.timezone) });
    } catch {
      return new Date(meeting.scheduledAt).toLocaleString('en-US');
    }
  })();
  const { notifyByEmail } = await import('./notification.service.js');

  let anyDelivered = false;
  for (const to of recipients) {
    const inviteName = resolveInviteeDisplayName(series, to);
    const personalUrl = getPublicMeetingUrl(meeting.meetingId, { name: inviteName, email: to });
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendMeetingInvitationEmail(to, {
        title: meeting.title,
        scheduledAt: meeting.scheduledAt,
        timezone: series.timezone,
        durationMinutes: meeting.durationMinutes,
        inviteeName: inviteName,
        hostName,
        interviewType: meeting.meetingType,
        jobPosition: '',
        description: meeting.description,
        publicMeetingUrl: personalUrl,
      });
      anyDelivered = true;
    } catch (err) {
      logger.warn(`[sendOccurrenceInvites] invite to ${to} failed: ${err?.message || err}`);
    }
    notifyByEmail(to, {
      type: 'meeting',
      title: meeting.title || 'Meeting invitation',
      message: `Upcoming meeting · ${scheduled}`,
      link: getInAppMeetingLink(meeting.meetingId, { name: inviteName, email: to }),
      relatedEntity: { type: 'meeting', id: meeting.meetingId },
      metadata: { seriesId: String(series._id), meetingKind: 'internal-series-occurrence' },
    }).catch(() => {});
  }

  if (!onlyEmails?.length && anyDelivered) {
    await InternalMeeting.updateOne(
      { _id: meetingId, invitationSentAt: null },
      { $set: { invitationSentAt: new Date() } }
    );
  }
  return anyDelivered;
};

/** Send invites for series occurrences that are visible but not yet emailed. */
export const sendDueOccurrenceInvites = async ({ now = new Date() } = {}) => {
  const pending = await InternalMeeting.find({
    seriesId: { $ne: null },
    status: 'scheduled',
    detached: { $ne: true },
    invitationSentAt: null,
  }).lean();

  let sent = 0;
  for (const m of pending) {
    const series = await MeetingSeries.findById(m.seriesId);
    if (!series || series.status !== 'active') continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await isOccurrenceInviteDue(series, m, now))) continue;
    // eslint-disable-next-line no-await-in-loop
    // eslint-disable-next-line no-await-in-loop
    if (await sendOccurrenceInvites(series, m)) sent += 1;
  }
  return { sent };
};

/**
 * Create the InternalMeeting occurrences that are due to become visible.
 * An occurrence materializes only once "now" enters its lead window (12h for
 * daily / back-to-back custom days, 24h for weekly/monthly/sparse custom), so
 * the list shows only the current scheduled occurrence; the next one is created
 * once that meeting ends and its own lead window opens.
 * The first occurrence of a brand-new series is always created immediately.
 * Idempotent: occurrences whose index ≤ lastOccurrenceIndex are skipped.
 * @param {Object} series - MeetingSeries document
 * @param {{ now?: Date }} [opts] - invitation emails are sent separately by
 *   sendDueOccurrenceInvites once the occurrence enters its visibility window.
 * @returns {Promise<{ created: number }>}
 */
export const materializeSeries = async (series, { now = new Date() } = {}) => {
  if (series.status !== 'active') return { created: 0 };
  const horizon = computeHorizon(now);
  const floor = seriesMaterializationFloor(series, now);
  const allOccurrences = generateOccurrences(series, horizon);
  const occurrences = allOccurrences.filter((o) => o.at.getTime() >= floor.getTime());
  const summary = recurrenceLabel(series.recurrence);
  const tpl = occurrenceTemplate(series);

  const pending = occurrences.filter((o) => o.index > (series.lastOccurrenceIndex ?? -1));

  // Gap to the previous occurrence decides the lead window for custom schedules.
  const prevAtOf = (o) => {
    const i = allOccurrences.findIndex((x) => x.index === o.index);
    return i > 0 ? allOccurrences[i - 1].at : null;
  };

  const durationMs = (series.durationMinutes || 60) * MINUTE_MS;

  // Only one scheduled occurrence per series at a time — the "current" meeting.
  const activeScheduled = await InternalMeeting.findOne({
    seriesId: series._id,
    status: 'scheduled',
    detached: { $ne: true },
  })
    .sort({ scheduledAt: 1 })
    .select('scheduledAt occurrenceIndex')
    .lean();

  if (activeScheduled) {
    const meetingEnd = new Date(new Date(activeScheduled.scheduledAt).getTime() + durationMs);
    const nextPending = pending.find((o) => o.index > (activeScheduled.occurrenceIndex ?? -1));
    if (nextPending) {
      const prevAt = new Date(activeScheduled.scheduledAt);
      const visibleAt = new Date(
        nextPending.at.getTime() - occurrenceLeadMs(series, prevAt, nextPending.at)
      );
      // Next row appears at the later of: current meeting ended, or its 12h/24h lead opens.
      series.nextMaterializationAt = new Date(
        Math.max(meetingEnd.getTime(), visibleAt.getTime(), now.getTime() + MINUTE_MS)
      );
    } else if (isFullyMaterialized(series, allOccurrences, horizon)) {
      series.nextMaterializationAt = null;
    } else {
      series.nextMaterializationAt = new Date(Math.max(meetingEnd.getTime(), now.getTime() + MINUTE_MS));
    }
    await series.save();
    return { created: 0 };
  }

  const neverMaterialized = (series.lastOccurrenceIndex ?? -1) < 0;
  const toCreate = [];
  let nextDueAt = null;
  for (let i = 0; i < pending.length; i += 1) {
    const o = pending[i];
    const isFirstEver = neverMaterialized && i === 0;
    const visibleAt = new Date(o.at.getTime() - occurrenceLeadMs(series, prevAtOf(o), o.at));
    if (isFirstEver || visibleAt.getTime() <= now.getTime()) {
      toCreate.push(o);
      break; // one occurrence per series
    }
    nextDueAt = visibleAt;
    break;
  }

  let created = 0;
  for (const o of toCreate) {
    try {
      const meetingId = await generateUniqueLivekitRoomId();
      const meeting = await InternalMeeting.create({
        ...tpl,
        meetingId,
        roomName: meetingId,
        scheduledAt: o.at,
        seriesId: series._id,
        occurrenceIndex: o.index,
        seriesVersion: series.seriesVersion,
        recurrenceSummary: summary,
        createdBy: series.createdBy,
      });
      created += 1;
      series.lastOccurrenceIndex = Math.max(series.lastOccurrenceIndex ?? -1, o.index);
      series.materializedUntil = o.at;
    } catch (err) {
      logger.warn(`[materializeSeries] Failed to create occurrence ${o.index} for series ${series._id}: ${err?.message || err}`);
    }
  }

  if (nextDueAt) {
    series.nextMaterializationAt = new Date(Math.max(nextDueAt.getTime(), now.getTime() + MINUTE_MS));
  } else if (isFullyMaterialized(series, allOccurrences, horizon)) {
    series.nextMaterializationAt = null; // bounded series fully generated
  } else {
    // "Never"-ending series with nothing pending inside the horizon: extend later.
    series.nextMaterializationAt = new Date(now.getTime() + 60 * MINUTE_MS);
  }
  await series.save();

  return { created };
};

/** Invite only newly-added recipients on the current scheduled occurrence. */
const sendInvitesToNewRecipients = async (series, addedEmails) => {
  if (!addedEmails.length) return;
  const active = await InternalMeeting.findOne({
    seriesId: series._id,
    status: 'scheduled',
    detached: { $ne: true },
  })
    .sort({ scheduledAt: 1 })
    .lean();
  if (!active) return;
  await sendOccurrenceInvites(series, active, { emails: addedEmails });
};

/**
 * Create a recurring series + materialize the first occurrence (invite follows visibility window).
 * @param {Object} body - same shape as createInternalMeeting plus { recurrence, startAt|scheduledAt, end }
 * @param {string} userId
 */
export const createMeetingSeries = async (body, userId) => {
  const startAt = body.startAt || body.scheduledAt;
  if (!startAt) throw new ApiError(httpStatus.BAD_REQUEST, 'startAt is required for a recurring meeting');

  const tz = normalizeTimezone(body.timezone);
  const createdAt = new Date();
  const effectiveStartAt = clampSeriesStartAt(startAt, createdAt, tz);

  const series = await MeetingSeries.create({
    title: body.title,
    description: body.description || '',
    timezone: tz,
    durationMinutes: Number(body.durationMinutes) || 60,
    maxParticipants: body.maxParticipants,
    allowGuestJoin: body.allowGuestJoin,
    requireApproval: body.requireApproval,
    meetingType: body.meetingType,
    hosts: body.hosts,
    emailInvites: body.emailInvites || [],
    notes: body.notes || '',
    recurrence: body.recurrence,
    startAt: effectiveStartAt,
    end: body.end || { mode: 'never' },
    seriesVersion: 1,
    status: 'active',
    createdBy: userId,
  });

  await materializeSeries(series, { now: createdAt });
  await sendDueOccurrenceInvites({ now: createdAt });

  const firstOccurrence = await InternalMeeting.findOne({ seriesId: series._id })
    .sort({ occurrenceIndex: 1 })
    .lean();

  const result = series.toJSON();
  result.recurrenceSummary = recurrenceLabel(series.recurrence);
  result.seriesId = series._id;
  // Success modal + invites expect the first occurrence's join fields, not only series metadata.
  if (firstOccurrence) {
    result.meetingId = firstOccurrence.meetingId;
    result.scheduledAt = firstOccurrence.scheduledAt;
    result.status = firstOccurrence.status;
    result.publicMeetingUrl = getPublicMeetingUrl(firstOccurrence.meetingId);
    result.occurrenceId = firstOccurrence._id;
  }
  return result;
};

/** Delete forward occurrences (scheduled, non-detached) and clean up their LiveKit rooms. */
const purgeForwardOccurrences = async (seriesId, fromIndex) => {
  const filter = {
    seriesId,
    status: 'scheduled',
    detached: false,
    occurrenceIndex: { $gte: fromIndex },
  };
  const doomed = await InternalMeeting.find(filter).select('meetingId').lean();
  await InternalMeeting.deleteMany(filter);
  for (const d of doomed) {
    deleteInterviewRoom(d.meetingId).catch((err) =>
      logger.warn(`[purgeForwardOccurrences] LiveKit delete failed ${d.meetingId}: ${err?.message || err}`)
    );
  }
  return doomed.length;
};

/**
 * Edit an occurrence / future occurrences / the whole series.
 * @param {string} meetingRef - occurrence _id or meetingId
 * @param {Object} body
 * @param {'single'|'future'|'series'} mode
 */
export const updateSeries = async (meetingRef, body, mode = 'single') => {
  const meeting = await resolveOccurrence(meetingRef);
  if (!meeting) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  const series = await MeetingSeries.findById(meeting.seriesId);
  if (!series) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting series not found');

  // ---- single: edit just this occurrence; detach so series regen skips it ----
  if (mode === 'single') {
    const safe = { ...body };
    const dur = Number(safe.durationMinutes);
    if (!(Number.isInteger(dur) && dur >= 1 && dur <= 480)) delete safe.durationMinutes;
    delete safe.recurrence;
    delete safe.end;
    Object.assign(meeting, safe, { detached: true });
    await meeting.save();
    return getInternalMeetingById(meeting._id.toString());
  }

  const fromIndex = mode === 'future' ? meeting.occurrenceIndex ?? 0 : 0;
  const reAnchor = 'recurrence' in body || 'startAt' in body || 'scheduledAt' in body;
  const tpl = pickTemplate(body);

  // Always propagate content/template changes to the series record.
  if (Object.keys(tpl).length) Object.assign(series, tpl);

  if (!reAnchor) {
    // Content-only change: update series + forward/all scheduled non-detached occurrences.
    await series.save();
    if (Object.keys(tpl).length) {
      const filter = { seriesId: series._id, status: 'scheduled', detached: false };
      if (mode === 'future') filter.occurrenceIndex = { $gte: fromIndex };
      await InternalMeeting.updateMany(filter, {
        $set: { ...tpl, recurrenceSummary: recurrenceLabel(series.recurrence) },
      });
    }
    const refreshed = await MeetingSeries.findById(series._id);
    return refreshed.toJSON();
  }

  // ---- rule/time change ----
  const newRecurrence =
    'recurrence' in body
      ? { ...(series.recurrence?.toObject?.() ?? series.recurrence), ...body.recurrence }
      : series.recurrence;
  const tz = normalizeTimezone(series.timezone);
  // Clamp against NOW (not the original createdAt): re-anchoring an old series
  // with a past start would otherwise generate past occurrences or, for
  // afterCount-bounded series, spend the whole count before today.
  const newStartAtRaw =
    'startAt' in body ? new Date(body.startAt) : 'scheduledAt' in body ? new Date(body.scheduledAt) : series.startAt;
  const newStartAt = clampSeriesStartAt(newStartAtRaw, new Date(), tz);

  if (mode === 'series') {
    // Re-anchor the whole series and regenerate from index 0.
    const beforeEmails = new Set(getInvitationEmails(series));
    await purgeForwardOccurrences(series._id, 0);
    series.recurrence = newRecurrence;
    series.startAt = newStartAt;
    if ('end' in body) series.end = body.end;
    series.seriesVersion = (series.seriesVersion || 1) + 1;
    series.lastOccurrenceIndex = -1;
    series.materializedUntil = null;
    series.nextMaterializationAt = null;
    series.status = 'active';
    await series.save();
    await materializeSeries(series);
    await sendDueOccurrenceInvites();
    const added = getInvitationEmails(series).filter((e) => !beforeEmails.has(e));
    await sendInvitesToNewRecipients(series, added);
    const refreshed = await MeetingSeries.findById(series._id);
    return refreshed.toJSON();
  }

  // mode === 'future' with a rule/time change → split (Google Calendar model):
  // truncate this series before fromIndex, start a NEW series for the future.
  await purgeForwardOccurrences(series._id, fromIndex);
  if (fromIndex <= 0) {
    series.status = 'cancelled';
  } else {
    series.end = { mode: 'afterCount', count: fromIndex }; // keep indices 0..fromIndex-1
    series.lastOccurrenceIndex = fromIndex - 1;
    series.nextMaterializationAt = null;
  }
  await series.save();

  const newSeries = await MeetingSeries.create({
    ...occurrenceTemplate(series),
    ...pickTemplate(body),
    timezone: series.timezone,
    recurrence: newRecurrence,
    startAt: newStartAt,
    end: 'end' in body ? body.end : { mode: 'never' },
    seriesVersion: 1,
    status: 'active',
    createdBy: series.createdBy,
  });
  await materializeSeries(newSeries);
  await sendDueOccurrenceInvites();
  const result = newSeries.toJSON();
  result.recurrenceSummary = recurrenceLabel(newSeries.recurrence);
  return result;
};

/**
 * Cancel an occurrence / future occurrences / the whole series. Occurrences are
 * soft-cancelled (status:'cancelled') so they remain visible, with LiveKit cleanup.
 * @param {string} meetingRef - occurrence _id or meetingId
 * @param {'single'|'future'|'series'} mode
 */
export const cancelSeries = async (meetingRef, mode = 'single') => {
  const meeting = await resolveOccurrence(meetingRef);
  if (!meeting) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  const series = await MeetingSeries.findById(meeting.seriesId);
  if (!series) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting series not found');

  const cancelOccurrences = async (filter) => {
    const targets = await InternalMeeting.find(filter).select('meetingId').lean();
    await InternalMeeting.updateMany(filter, { $set: { status: 'cancelled' } });
    for (const t of targets) {
      deleteInterviewRoom(t.meetingId).catch((err) =>
        logger.warn(`[cancelSeries] LiveKit delete failed ${t.meetingId}: ${err?.message || err}`)
      );
    }
    return targets.length;
  };

  if (mode === 'single') {
    meeting.status = 'cancelled';
    meeting.detached = true;
    await meeting.save();
    deleteInterviewRoom(meeting.meetingId).catch(() => {});
    return { cancelled: 1 };
  }

  const fromIndex = mode === 'future' ? meeting.occurrenceIndex ?? 0 : 0;
  const filter = { seriesId: series._id, status: 'scheduled', occurrenceIndex: { $gte: fromIndex } };
  const cancelled = await cancelOccurrences(filter);

  if (mode === 'series' || fromIndex <= 0) {
    series.status = 'cancelled';
  } else {
    series.end = { mode: 'afterCount', count: fromIndex };
    series.lastOccurrenceIndex = Math.min(series.lastOccurrenceIndex, fromIndex - 1);
  }
  series.nextMaterializationAt = null;
  await series.save();
  return { cancelled };
};

/**
 * Permanently delete an entire series and all its occurrences (any status).
 * Use after soft-cancel when rows should disappear from the meetings list.
 * @param {string} meetingRef - occurrence _id or meetingId
 */
export const purgeSeries = async (meetingRef) => {
  const meeting = await resolveOccurrence(meetingRef);
  if (!meeting) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  const series = await MeetingSeries.findById(meeting.seriesId);
  if (!series) throw new ApiError(httpStatus.NOT_FOUND, 'Meeting series not found');

  const all = await InternalMeeting.find({ seriesId: series._id }).select('meetingId').lean();
  await InternalMeeting.deleteMany({ seriesId: series._id });
  for (const row of all) {
    deleteInterviewRoom(row.meetingId).catch((err) =>
      logger.warn(`[purgeSeries] LiveKit delete failed ${row.meetingId}: ${err?.message || err}`)
    );
  }
  await MeetingSeries.deleteOne({ _id: series._id });
  return { deleted: all.length };
};

/**
 * Top up every active series whose horizon is due. Indexed query keeps the
 * scheduler from scanning all active series each tick.
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ series: number, created: number }>}
 */
export const materializeDueSeries = async ({ now = new Date() } = {}) => {
  const due = await MeetingSeries.find({
    status: 'active',
    nextMaterializationAt: { $ne: null, $lte: now },
  });
  let created = 0;
  for (const series of due) {
    try {
      const res = await materializeSeries(series, { now });
      created += res.created;
    } catch (err) {
      logger.warn(`[materializeDueSeries] series ${series._id} failed: ${err?.message || err}`);
    }
  }
  return { series: due.length, created };
};

export default {
  createMeetingSeries,
  materializeSeries,
  materializeDueSeries,
  sendDueOccurrenceInvites,
  updateSeries,
  cancelSeries,
  purgeSeries,
};
