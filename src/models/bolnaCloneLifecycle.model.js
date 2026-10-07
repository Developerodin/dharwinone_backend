import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

export const BOLNA_CLONE_LIFECYCLE_STATES = [
  'initiated',
  'terminal_event_seen',
  'snapshot_pending',
  'snapshot_partial',
  'snapshot_complete',
  'snapshot_exhausted',
  'cleanup_pending',
  'cleaned',
];

const completenessSchema = new mongoose.Schema(
  {
    core: { type: Boolean, default: false },
    telephony: { type: Boolean, default: false },
    transcript: { type: Boolean, default: false },
    extracted: { type: Boolean, default: false },
    context: { type: Boolean, default: false },
    costUsage: { type: Boolean, default: false },
    agentMetadata: { type: Boolean, default: false },
    promptSnapshot: { type: Boolean, default: false },
  },
  { _id: false }
);

const bolnaCloneLifecycleSchema = new mongoose.Schema(
  {
    executionId: { type: String, required: true, unique: true, index: true },
    cloneAgentId: { type: String, required: true, trim: true, index: true },
    cloneAgentVersionId: { type: String, default: null, trim: true },
    callRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallRecord', default: null },
    correlationKey: { type: String, default: null, index: true },
    state: {
      type: String,
      enum: BOLNA_CLONE_LIFECYCLE_STATES,
      default: 'initiated',
      index: true,
    },
    terminal: {
      seenAt: { type: Date, default: null },
      eventId: { type: String, default: null },
      status: { type: String, default: null },
      smartStatus: { type: String, default: null },
      errorMessage: { type: String, default: null },
    },
    snapshot: {
      status: { type: String, enum: ['pending', 'partial', 'complete', 'exhausted'], default: 'pending' },
      attempts: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 8 },
      lastAttemptAt: { type: Date, default: null },
      nextRetryAt: { type: Date, default: null, index: true },
      lastSuccessAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      completeness: { type: completenessSchema, default: () => ({}) },
      missingSections: { type: [String], default: [] },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
      /** gzip-base64 redacted execution logs (see snapshot.payload.executionLogs pointer). */
      executionLogsArchive: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    workerLease: {
      holder: { type: String, default: null },
      expiresAt: { type: Date, default: null, index: true },
      phase: { type: String, enum: ['snapshot', 'cleanup'], default: null },
    },
    cleanup: {
      status: { type: String, enum: ['pending', 'retrying', 'done', 'blocked'], default: 'pending' },
      eligible: { type: Boolean, default: true },
      blockedReason: { type: String, default: null },
      attempts: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 6 },
      lastAttemptAt: { type: Date, default: null },
      nextRetryAt: { type: Date, default: null, index: true },
      deleteEligibleAt: { type: Date, default: null, index: true },
      deletedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
    },
    prompt: {
      renderToken: { type: String, default: null },
      hash: { type: String, default: null },
      question1: { type: String, default: null },
      text: { type: String, default: null },
      requestSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    audit: {
      lastTransitionAt: { type: Date, default: null },
      transitionReason: { type: String, default: null },
    },
  },
  { timestamps: true }
);

bolnaCloneLifecycleSchema.index({ state: 1, 'snapshot.nextRetryAt': 1 });
bolnaCloneLifecycleSchema.index({ state: 1, 'cleanup.deleteEligibleAt': 1, 'cleanup.nextRetryAt': 1 });
bolnaCloneLifecycleSchema.index({ state: 1, 'workerLease.expiresAt': 1, 'snapshot.nextRetryAt': 1 });
bolnaCloneLifecycleSchema.plugin(toJSON);

const BolnaCloneLifecycle = mongoose.model('BolnaCloneLifecycle', bolnaCloneLifecycleSchema);
export default BolnaCloneLifecycle;
