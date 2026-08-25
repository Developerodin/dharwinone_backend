import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const SOURCES = ['active-jobs-db', 'linkedin-job-search-api'];

/**
 * Admin-configured recurring External Jobs fetch: titles x locations, run on a
 * schedule (or manually), synced via externalJobAutoFetch.service.js (one shared
 * sync path for both the scheduler tick and "Fetch Now" -- see that file).
 *
 * Schema supports multiple configs (nothing here assumes a singleton); the
 * current UI/controller manage exactly one via a get-or-create lookup.
 */
const externalJobAutoFetchConfigSchema = new mongoose.Schema(
  {
    titles: { type: [{ type: String, trim: true }], default: [] },
    locations: { type: [{ type: String, trim: true }], default: [] },
    source: { type: String, enum: SOURCES, default: 'active-jobs-db' },
    postedRange: { type: String, enum: ['24h', '7d'], default: '24h' },
    remoteOnly: { type: Boolean, default: false },
    /** Minimum minutes between runs; the scheduler polls on a fixed short tick and checks this. */
    frequencyMinutes: { type: Number, enum: [60, 360, 720, 1440], default: 1440 },
    enabled: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastRunAt: { type: Date, default: null },
    lastRunStatus: {
      type: String,
      enum: ['never', 'running', 'completed', 'failed', 'partial'],
      default: 'never',
    },
  },
  { timestamps: true }
);

externalJobAutoFetchConfigSchema.plugin(toJSON);

export const AUTO_FETCH_SOURCES = SOURCES;
export default mongoose.model('ExternalJobAutoFetchConfig', externalJobAutoFetchConfigSchema);
