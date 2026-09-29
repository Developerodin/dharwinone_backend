import mongoose from 'mongoose';

const conversationMemorySchema = new mongoose.Schema(
  {
    // (userId, adminId) is covered by the unique compound index declared below;
    // field-level `index: true` here creates redundant single-field indexes
    // and emits the "Duplicate schema index" warning on boot.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * Identity pointers the legacy Sage pipeline (removed 2026-09) wrote per
     * (userId, adminId). Nothing writes them any more; they stay declared only
     * so entityCleanup.js and memorySweep.scheduler.js can still scrub deleted
     * people/roles/jobs out of rows written before the removal, until the TTL
     * index expires those rows. Every other legacy field was dropped from the
     * schema; old documents just carry the extra keys until they expire.
     */
    lastEntities: {
      personUserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',     default: null },
      personEmpDocId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
      roleId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Role',     default: null },
      roleSlug:        { type: String, default: null, trim: true },
      jobId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Job',      default: null },
      person:          { type: String, default: null, trim: true },
      email:           { type: String, default: null, trim: true },
      employeeId:      { type: String, default: null, trim: true },
      role:            { type: String, default: null, trim: true },
      jobTitle:        { type: String, default: null, trim: true },
    },
    /** Legacy listing cursor — scrubbed by memorySweep.scheduler.js only (see lastEntities). */
    lastListing: {
      role:             { type: String, default: null, trim: true },
      employmentScope:  { type: String, default: null, trim: true },
      cursor: {
        lastEmployeeId: { type: String, default: null, trim: true },
        lastId:         { type: mongoose.Schema.Types.ObjectId, default: null },
        lastSortKey:    { type: String, default: null, trim: true },
      },
      total:            { type: Number, default: 0 },
      pageSize:         { type: Number, default: 25 },
      lastQuery:        { type: String, default: null, trim: true },
      updatedAt:        { type: Date, default: null },
    },
    /**
     * Tool-call ledger for Sage's agent loop — capped to the last 6 agent
     * turns, feeds follow-ups. Raw tool outputs are never stored here, only
     * compact { tool, args, total } summaries (see chatAssistant/agent/context.js).
     */
    agentLedger: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

conversationMemorySchema.index({ userId: 1, adminId: 1 }, { unique: true });
conversationMemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ConversationMemory = mongoose.model('ConversationMemory', conversationMemorySchema);
export default ConversationMemory;
