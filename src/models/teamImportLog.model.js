import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const teamImportLogSchema = new mongoose.Schema(
  {
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fileName: { type: String, trim: true },
    fileSize: { type: Number },
    fileHash: { type: String, index: true },
    rowsProcessed: { type: Number, default: 0 },
    teamsCreated: { type: Number, default: 0 },
    teamsUpdated: { type: Number, default: 0 },
    employeesAdded: { type: Number, default: 0 },
    employeesIgnored: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    ambiguousNames: { type: Number, default: 0 },
    teamLeadSkipped: { type: Number, default: 0 },
    metadataConflicts: { type: Number, default: 0 },
    skipReasonCounts: { type: Map, of: Number, default: {} },
    summaryFileKey: { type: String, trim: true },
  },
  { timestamps: true }
);

teamImportLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
teamImportLogSchema.plugin(toJSON);

export default mongoose.model('TeamImportLog', teamImportLogSchema);
