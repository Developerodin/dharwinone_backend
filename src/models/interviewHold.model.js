import mongoose from 'mongoose';
import { toJSON } from './plugins/index.js';

export const HOLD_STATUSES = ['held', 'approving', 'approved', 'rejected', 'expired', 'cancelled'];

const interviewHoldSchema = new mongoose.Schema(
  {
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', required: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    interviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    start: { type: Date, required: true },
    durationMinutes: { type: Number, required: true },
    candidateTimezone: { type: String, trim: true },
    round: {
      index: { type: Number, default: null },
      type: { type: String, default: null },
      label: { type: String, default: null },
      planKey: { type: String, default: null },
    },
    source: { type: String, enum: ['ai_call', 'link'], required: true },
    callRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallRecord' },
    status: { type: String, enum: HOLD_STATUSES, default: 'held' },
    /** True while the hold reserves the slot (status held/approving). An approved hold's Meeting is the busy source. */
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, required: true },
    expiryReminderSentAt: { type: Date },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    rejectReason: { type: String, trim: true },
  },
  { timestamps: true }
);

interviewHoldSchema.index({ applicationId: 1 }, { unique: true, partialFilterExpression: { active: true } });
interviewHoldSchema.index({ interviewerId: 1, start: 1 }, { unique: true, partialFilterExpression: { active: true } });
interviewHoldSchema.index({ status: 1, expiresAt: 1 });
// Call-records page looks up the hold per call (attachInterviewSlots).
interviewHoldSchema.index({ callRecordId: 1, createdAt: -1 }, { partialFilterExpression: { callRecordId: { $exists: true } } });

interviewHoldSchema.plugin(toJSON);

const InterviewHold = mongoose.model('InterviewHold', interviewHoldSchema);

export default InterviewHold;
