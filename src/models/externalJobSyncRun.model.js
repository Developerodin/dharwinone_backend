import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

/**
 * One run-history row per auto-fetch sync (scheduled or manual "Fetch Now").
 * Drives the status panel: last run, result counts, next run, failure reason.
 */
const externalJobSyncRunSchema = new mongoose.Schema(
  {
    configId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExternalJobAutoFetchConfig',
      required: true,
      index: true,
    },
    trigger: { type: String, enum: ['scheduled', 'manual'], required: true },
    status: {
      type: String,
      enum: ['running', 'completed', 'failed', 'partial'],
      default: 'running',
    },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    stats: {
      fetched: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      staleArchived: { type: Number, default: 0 },
      queriesRun: { type: Number, default: 0 },
      queriesFailed: { type: Number, default: 0 },
    },
    errorMessage: { type: String, trim: true, default: null },
    /** Per-query failures within an otherwise-successful run (rate limit, 404, timeout, ...). */
    failedQueries: {
      type: [
        {
          title: { type: String, trim: true },
          location: { type: String, trim: true },
          error: { type: String, trim: true },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

externalJobSyncRunSchema.index({ configId: 1, createdAt: -1 });
externalJobSyncRunSchema.plugin(toJSON);

export default mongoose.model('ExternalJobSyncRun', externalJobSyncRunSchema);
