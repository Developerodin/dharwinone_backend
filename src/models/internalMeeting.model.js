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
    reminderSentAt: {
      type: Date,
      default: null,
    },
    // Set when the per-occurrence invitation email is sent (recurring series).
    invitationSentAt: {
      type: Date,
      default: null,
    },
    // Per-window reminder dedup, keyed by lead-minutes (e.g. { '60': Date, '15': Date }).
    // Drives the config-driven reminder windows in internalMeeting.service.js so adding
    // a window needs no schema change. `reminderSentAt` above is kept for back-compat.
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

const InternalMeeting = mongoose.model('InternalMeeting', internalMeetingSchema);
export default InternalMeeting;
