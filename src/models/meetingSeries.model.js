import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * Recurring internal-meeting series. Holds the recurrence rule + the shared
 * template; individual occurrences are materialized as InternalMeeting docs
 * (each with seriesId + occurrenceIndex) so all join/LiveKit/recording logic is
 * reused as-is. See meetingSeries.service.js for materialization.
 */
const recurrenceSchema = mongoose.Schema(
  {
    // 'custom' behaves like weekly-with-daysOfWeek when daysOfWeek is set, else daily.
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'custom'],
      required: true,
    },
    interval: { type: Number, default: 1, min: 1 }, // every N days/weeks/months
    daysOfWeek: { type: [Number], default: [] }, // 0=Sun .. 6=Sat (JS getDay convention)
    dayOfMonth: { type: Number, default: null, min: 1, max: 31 }, // monthly
  },
  { _id: false }
);

const endSchema = mongoose.Schema(
  {
    mode: { type: String, enum: ['never', 'onDate', 'afterCount'], default: 'never' },
    untilDate: { type: Date, default: null }, // onDate
    count: { type: Number, default: null, min: 1 }, // afterCount
  },
  { _id: false }
);

const meetingSeriesSchema = mongoose.Schema(
  {
    // ---- shared template (mirrors internalMeeting.model.js) ----
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    timezone: { type: String, trim: true, default: 'UTC' },
    durationMinutes: { type: Number, required: true, default: 60 },
    maxParticipants: { type: Number, default: 10 },
    allowGuestJoin: { type: Boolean, default: false },
    requireApproval: { type: Boolean, default: false },
    meetingType: { type: String, enum: ['Video', 'In-Person', 'Phone'], default: 'Video' },
    hosts: [
      {
        nameOrRole: { type: String, trim: true, default: '' },
        email: { type: String, required: true, trim: true },
      },
    ],
    emailInvites: [{ type: String, trim: true }],
    notes: { type: String, trim: true, default: '' },

    // ---- recurrence rule ----
    recurrence: { type: recurrenceSchema, required: true },
    startAt: { type: Date, required: true }, // first occurrence (wall-clock anchored via timezone)
    end: { type: endSchema, default: () => ({ mode: 'never' }) },

    // ---- materialization bookkeeping ----
    materializedUntil: { type: Date, default: null }, // rolling high-water mark
    lastOccurrenceIndex: { type: Number, default: -1 }, // highest occurrenceIndex generated (-1 = none)
    // When the scheduler should next top up this series. Indexed so the tick can
    // query {status:'active', nextMaterializationAt:{$lte:now}} instead of scanning
    // every active series. null/far-future once a bounded series is fully materialized.
    nextMaterializationAt: { type: Date, default: null, index: true },
    // Bumped on every rule/template edit; copied onto each occurrence so you can tell
    // which rule revision generated a given occurrence.
    seriesVersion: { type: Number, default: 1 },

    status: { type: String, enum: ['active', 'ended', 'cancelled'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

meetingSeriesSchema.plugin(toJSON);
meetingSeriesSchema.plugin(paginate);

const MeetingSeries = mongoose.model('MeetingSeries', meetingSeriesSchema);
export default MeetingSeries;
