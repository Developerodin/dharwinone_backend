import mongoose from 'mongoose';

const conversationMemorySchema = new mongoose.Schema(
  {
    // (userId, adminId) is covered by the unique compound index declared below;
    // field-level `index: true` here creates redundant single-field indexes
    // and emits the "Duplicate schema index" warning on boot.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    summary: { type: String, default: '' },
    turnCount: { type: Number, default: 0 },
    /**
     * Session entity tracking — last referenced person / role / job per
     * (userId, adminId). Persisted between turns so follow-up questions
     * resolve against the prior turn instead of an empty context.
     *
     * Identity is keyed on ObjectIds (`personUserId`, `personEmpDocId`,
     * `roleId`, `jobId`). The plain-string fields are display-only
     * snapshots — accurate at write time, but readers must re-resolve
     * through the live collection before trusting them, because names rot
     * on rename and rows can be deleted.
     *
     * Legacy plain-string fields (`person`, `role`, `employeeId`,
     * `jobTitle`) are kept so memory documents that predate the ID
     * migration still resolve correctly via name lookup. New writes
     * populate both ID and snapshot.
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
      lastDate:        { type: String, default: null, trim: true },
      lastDateLabel:   { type: String, default: null, trim: true },
      lastFromDate:    { type: String, default: null, trim: true },
      lastToDate:      { type: String, default: null, trim: true },
      lastTopic:       { type: String, default: null, trim: true },
      lastScope:       { type: String, default: null, trim: true },
      updatedAt:       { type: Date, default: null },
    },
    /**
     * Pagination cursor for the most recent multi-record listing
     * (employees, agents, etc.). Lets "show more" / "next" continue
     * from the previous page without re-classifying. Cleared when
     * the user starts a new topic.
     */
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
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

conversationMemorySchema.index({ userId: 1, adminId: 1 }, { unique: true });
conversationMemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ConversationMemory = mongoose.model('ConversationMemory', conversationMemorySchema);
export default ConversationMemory;
