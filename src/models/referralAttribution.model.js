import mongoose from 'mongoose';
import { ATTRIBUTION_SOURCE } from '../constants/salesAgentAttribution.js';

const salesAgentSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    employeeCode: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const jobSnapshotSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true },
    requisitionCode: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const referralAttributionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    subjectProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    salesAgentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    salesAgentSnapshot: { type: salesAgentSnapshotSchema, required: true },
    jobSnapshot: { type: jobSnapshotSchema, default: null },
    lifecycleStageAtAssignment: { type: String, required: true },
    attributionEventId: { type: String, required: true, index: true },
    assignedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, required: true },
    notes: { type: String, trim: true, maxlength: 2000, default: null },
    source: {
      type: String,
      enum: Object.values(ATTRIBUTION_SOURCE),
      default: ATTRIBUTION_SOURCE.MANUAL_ASSIGN,
    },
    previousAttributionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReferralAttribution',
      default: null,
    },
    isCurrent: { type: Boolean, default: true, index: true },
    isRevoked: { type: Boolean, default: false, index: true },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, trim: true, maxlength: 2000, default: null },
  },
  { timestamps: true }
);

referralAttributionSchema.index(
  { tenantId: 1, subjectProfileId: 1, jobId: 1, isCurrent: 1, isRevoked: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true, isRevoked: false } }
);

referralAttributionSchema.index({ tenantId: 1, salesAgentUserId: 1, isCurrent: 1, isRevoked: 1 });
referralAttributionSchema.index({ tenantId: 1, subjectProfileId: 1, assignedAt: -1 });
referralAttributionSchema.index({ tenantId: 1, assignedAt: -1 });
referralAttributionSchema.index({ attributionEventId: 1 });

export default mongoose.models.ReferralAttribution
  || mongoose.model('ReferralAttribution', referralAttributionSchema);
