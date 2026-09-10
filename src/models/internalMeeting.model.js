import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * Quick internal / team meetings (Communication). Not ATS interviews.
 * LiveKit room name = meetingId (same pattern as Meeting collection).
 */
const internalMeetingSchema = mongoose.Schema(
  {
    meetingId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    roomName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    scheduledAt: {
      type: Date,
      required: true,
    },
    timezone: {
      type: String,
      trim: true,
      default: 'UTC',
    },
    durationMinutes: {
      type: Number,
      required: true,
      default: 60,
    },
    maxParticipants: {
      type: Number,
      default: 10,
    },
    allowGuestJoin: {
      // Invite-only by default — see meeting.model.js. When false the public token
      // path enforces the invite list (hosts + emailInvites), so a bare meeting URL
      // alone cannot join. Set true only to deliberately open the link to anyone.
      type: Boolean,
      default: false,
    },
    requireApproval: {
      type: Boolean,
      default: false,
    },
    meetingType: {
      type: String,
      enum: ['Video', 'In-Person', 'Phone'],
      default: 'Video',
    },
    hosts: [
      {
        nameOrRole: { type: String, trim: true, default: '' },
        email: { type: String, required: true, trim: true },
      },
    ],
    emailInvites: [
      {
        type: String,
        trim: true,
      },
    ],
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    admittedIdentities: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['scheduled', 'ended', 'cancelled'],
      default: 'scheduled',
    },
    endedAt: {
      type: Date,
      default: null,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    // Set when the per-occurrence invitation email is sent (recurring series).
    invitationSentAt: {
      type: Date,
      default: null,
    },
    // Materialised reminder schedule: one entry per configured lead time, with dueAt
    // computed from scheduledAt at create and on reschedule. Selecting on dueAt instead of
    // matching scheduledAt against a moving band means a reminder fires at its real lead
    // time, survives a missed tick instead of falling out of a window, and cannot be
    // double-sent by two processes configured with different lead times — the entry, not
    // the config, is the unit of work. Entries already past at booking are never created:
    // for a meeting booked inside its own lead time the invitation is the notice.
    reminders: [
      {
        _id: false,
        leadMinutes: { type: Number, required: true },
        dueAt: { type: Date, required: true },
        sentAt: { type: Date, default: null },
      },
    ],
    // Legacy per-window dedup, keyed by lead-minutes (e.g. { '60': Date, '15': Date }).
    // Still written when a reminder is sent so a process running the previous band-matching
    // code does not re-send the same reminder during a rollout. `reminderSentAt` above is
    // kept for the same reason. Both are read-only for the current pass.
    reminderState: {
      type: Map,
      of: Date,
      default: () => new Map(),
    },
    // ---- recurring-series linkage (null for one-off meetings) ----
    seriesId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeetingSeries',
      default: null,
      index: true,
    },
    occurrenceIndex: { type: Number, default: null }, // 0-based position within the series
    seriesVersion: { type: Number, default: null }, // copied from the series at materialization
    // Set when a single occurrence is edited so series regen / "future" edits skip it.
    detached: { type: Boolean, default: false },
    recurrenceSummary: { type: String, default: '' }, // denormalized label e.g. "Weekly" for list badge
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

internalMeetingSchema.plugin(toJSON);
internalMeetingSchema.plugin(paginate);

/**
 * dateFrom/dateTo window queries (dashboard "today", meetings list date filter).
 *
 * This model declared no indexes at all, so the dateFrom/dateTo filter the endpoint
 * has always accepted was served by a collection scan. The range on scheduledAt is the
 * selective predicate for every such query and also satisfies the scheduledAt sort.
 *
 * Derived from the schema and the query shape, NOT from an explain() run — no DB was
 * available when it was added. Correctness does not depend on it; only latency does.
 *
 * autoIndex is OFF in production (config.js), so shipping this file does NOT build the
 * index. It needs a deliberate index-creation step on deploy.
 */
internalMeetingSchema.index({ scheduledAt: 1 });
// Reminder pass: due, unsent entries on scheduled meetings. Both keys live in the same
// array, so this stays a legal compound multikey index.
internalMeetingSchema.index({ status: 1, 'reminders.dueAt': 1, 'reminders.sentAt': 1 });

const InternalMeeting = mongoose.model('InternalMeeting', internalMeetingSchema);
export default InternalMeeting;
