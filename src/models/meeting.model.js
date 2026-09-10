import mongoose from 'mongoose';
import crypto from 'crypto';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';
import { INTERVIEW_STATUSES, INTERVIEW_RESULTS } from '../constants/atsPipeline.js';
import {
  RUBRIC_CRITERION_IDS,
  RUBRIC_RATING_MIN,
  RUBRIC_RATING_MAX,
} from '../constants/interviewRubric.js';

const meetingSchema = mongoose.Schema(
  {
    // Unique ID for public URL and LiveKit room name (e.g. meeting_0a33c0436e6c302d)
    meetingId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // LiveKit room name (same as meetingId). Kept for legacy index roomName_1.
    roomName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // --- Old-project fields ---
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
      // Invite-only by default. When false, the public token path enforces the
      // invite list (hosts + emailInvites + candidate + recruiter), so a bare
      // meeting URL is not enough to join — the joiner's email must be invited.
      // Set true only to deliberately open a meeting to anyone with the link.
      type: Boolean,
      default: false,
    },
    requireApproval: {
      type: Boolean,
      default: false,
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
    // --- Current Schedule Interview fields ---
    jobPosition: {
      type: String,
      trim: true,
    },
    interviewType: {
      type: String,
      enum: ['Video', 'In-Person', 'Phone'],
      default: 'Video',
    },
    candidate: {
      id: { type: String, trim: true }, // MongoDB ObjectId or external/mock id (e.g. "1")
      name: { type: String, trim: true },
      email: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    recruiter: {
      id: { type: String, trim: true }, // MongoDB ObjectId or external/mock id (e.g. "1")
      name: { type: String, trim: true },
      email: { type: String, trim: true },
    },
    /**
     * Assigned interview agents — denormalized snapshot, captured at schedule
     * time. Mirrors the candidate/recruiter embedded pattern; `id` is retained
     * for live user lookup.
     */
    agents: [
      {
        id: { type: String, trim: true },
        name: { type: String, trim: true },
        email: { type: String, trim: true },
      },
    ],
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    // --- System ---
    /** LiveKit participant identities granted publish after host admit (survives API restarts / multi-instance) */
    admittedIdentities: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: INTERVIEW_STATUSES,
      default: 'scheduled',
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    /**
     * The exact moment this interview's reminder becomes due, computed from scheduledAt at
     * create and on reschedule. The pass selects on it instead of matching scheduledAt
     * against a moving band, so a reminder fires at its real lead time, stays due through a
     * missed tick or a failed send instead of falling out of a window, and cannot be
     * duplicated by two processes configured with different lead times.
     * Null for interviews booked inside their own lead time — there is no earlier moment
     * left to fire and the invitation is the notice — and for rows predating this field.
     */
    remindAt: {
      type: Date,
      default: null,
    },
    /** Success marker for the post-interview "Conclusion of Meeting" reminder. */
    conclusionNotifiedAt: {
      type: Date,
      default: null,
    },
    /** Set (set-if-null) when the meeting transitions to status 'ended'. */
    interviewCompletedAt: {
      type: Date,
      default: null,
    },
    /** Lease + retry + observability metadata for the T-10 reminder. */
    reminderRetry: {
      attempts: { type: Number, default: 0 },
      claimedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      lastErrorAt: { type: Date, default: null },
      lastErrorCategory: {
        type: String,
        enum: ['timeout', 'invalid_recipient', 'template_failure', 'provider_failure', 'unknown'],
        default: null,
      },
      failedAt: { type: Date, default: null },
    },
    /** Lease + retry + observability metadata for the Conclusion reminder. */
    conclusionRetry: {
      attempts: { type: Number, default: 0 },
      claimedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      lastErrorAt: { type: Date, default: null },
      lastErrorCategory: {
        type: String,
        enum: ['timeout', 'invalid_recipient', 'template_failure', 'provider_failure', 'unknown'],
        default: null,
      },
      failedAt: { type: Date, default: null },
    },
    /** Interview result: pending (not decided), selected, rejected */
    interviewResult: {
      type: String,
      enum: INTERVIEW_RESULTS,
      default: 'pending',
    },
    /**
     * Interview rubric scores (PRD 5.4). Fixed criteria, equal weight, informational only —
     * nothing here gates or derives `interviewResult`.
     *
     * One score set per interview: whoever saves last owns it, and `scoredBy`/`scoredAt`
     * record that authorship for later readers. Partial scoring is allowed — a criterion the
     * scorer skipped is simply absent from `ratings`, it is not stored as 0.
     *
     * ponytail: no per-interviewer panels. Add a `scores: [{ user, ratings }]` array if
     * independent panel scoring is ever needed.
     */
    interviewScorecard: {
      ratings: [
        {
          _id: false,
          criterion: { type: String, enum: RUBRIC_CRITERION_IDS, required: true },
          rating: { type: Number, min: RUBRIC_RATING_MIN, max: RUBRIC_RATING_MAX, required: true },
        },
      ],
      comment: { type: String, default: '', trim: true },
      scoredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      scoredAt: { type: Date, default: null },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /** P3: explicit tenant boundary. Populated from creator's adminId at creation time. */
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  },
  {
    timestamps: true,
  }
);

meetingSchema.plugin(toJSON);
meetingSchema.plugin(paginate);

// Scheduler query indexes (see meeting.service.js reminder passes).
meetingSchema.index({ status: 1, reminderSentAt: 1, scheduledAt: 1 });
// Reminder pass: due, unsent interviews.
meetingSchema.index({ status: 1, reminderSentAt: 1, remindAt: 1 });
meetingSchema.index({ status: 1, conclusionNotifiedAt: 1, scheduledAt: 1 });
meetingSchema.index({ 'candidate.id': 1 });

/**
 * dateFrom/dateTo window queries (dashboard "today", Interviews table date filter).
 *
 * The two scheduler indexes above cannot serve these: their leading key is `status`,
 * and buildMeetingsMongoFilter expresses status as a case-insensitive $regex plus an
 * $or over null/''/missing — never an equality — so the prefix is unusable. Here the
 * range on scheduledAt is the selective predicate anyway (one day out of years), and
 * this index also satisfies the scheduledAt sort.
 *
 * Derived from the schema and the query shape, NOT from an explain() run — no DB was
 * available when it was added. Correctness does not depend on it; only latency does.
 *
 * autoIndex is OFF in production (config.js), so shipping this file does NOT build the
 * index. It needs a deliberate index-creation step on deploy.
 */
meetingSchema.index({ scheduledAt: 1 });

/**
 * Generate unique meetingId
 * @returns {string}
 */
meetingSchema.statics.generateMeetingId = async function () {
  let id;
  let exists = true;
  while (exists) {
    id = `meeting_${crypto.randomBytes(8).toString('hex')}`;
    const found = await this.findOne({ meetingId: id });
    exists = !!found;
  }
  return id;
};

const Meeting = mongoose.model('Meeting', meetingSchema);
export default Meeting;
