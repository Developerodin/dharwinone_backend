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
      /** Resolved calendar year from the last temporal window (for month-only follow-ups). */
      lastYear:        { type: Number, default: null },
      lastTopic:       { type: String, default: null, trim: true },
      lastScope:       { type: String, default: null, trim: true },
      /** Project graph memory — follow-ups after project count / team mapping. */
      lastProjectCount: { type: Number, default: null },
      lastProjectNames: { type: [String], default: undefined },
      lastProjectId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
      projectName:      { type: String, default: null, trim: true },
      lastTeamName:     { type: String, default: null, trim: true },
      teamId:           { type: mongoose.Schema.Types.ObjectId, ref: 'TeamGroup', default: null },
      /** Task / sprint graph memory — follow-ups after task board or workload analytics. */
      lastSprintId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Sprint', default: null },
      lastSprintName:   { type: String, default: null, trim: true },
      lastAssigneeName: { type: String, default: null, trim: true },
      lastTaskFilter:   { type: String, default: null, trim: true },
      /** Reference resolver — entity type / intent from last authoritative fetch. */
      lastEntityType:   { type: String, default: null, trim: true },
      lastIntent:       { type: String, default: null, trim: true },
      lastMetric:       { type: String, default: null, trim: true },
      /**
       * Canonical employee entityQuery context — filters/operations from the last
       * deterministic employee query. Used for "list them" replay without LLM.
       */
      lastContext:      { type: mongoose.Schema.Types.Mixed, default: null },
      /**
       * Multi-group query context for compound filter composition (OR groups).
       * Persists filterGroups, active group, page, and intent across turns.
       */
      currentQueryContext: { type: mongoose.Schema.Types.Mixed, default: null },
      /** Org structure count memory (departments, managers, supervisors). */
      lastOrgCount:     { type: Number, default: null },
      /** Last listing snapshot for ordinal resolution ("the second one"). */
      lastResultList:   { type: [mongoose.Schema.Types.Mixed], default: undefined },
      /** Hierarchical focus stack for multi-hop org drill-down (future). */
      focusStack:       { type: [mongoose.Schema.Types.Mixed], default: undefined },
      /** Pending business-concept clarification (e.g. manager ambiguity). */
      pendingConceptClarification: {
        concept:       { type: String, default: null, trim: true },
        originalQuery: { type: String, default: null, trim: true },
        options:       { type: [mongoose.Schema.Types.Mixed], default: undefined },
        updatedAt:     { type: Date, default: null },
      },
      /**
       * Pending person disambiguation. A sibling of pendingConceptClarification,
       * NOT a key inside lastContext — saveEmployeeQueryContext.js:42 replaces
       * lastContext wholesale on every deterministic employee turn.
       */
      pendingPersonDisambiguation: {
        query:     { type: String, default: null, trim: true },
        matches:   { type: [mongoose.Schema.Types.Mixed], default: undefined },
        createdAt: { type: Date, default: null },
      },
      /** Person-profile conversation state — communicated field keys per subject. */
      personConversationState: {
        entityId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        entityType:          { type: String, default: 'user', trim: true },
        name:                { type: String, default: null, trim: true },
        communicatedFields:  { type: [String], default: undefined },
        updatedAt:           { type: Date, default: null },
      },
      /** Title-ambiguity position context — job posting vs employee designation follow-ups. */
      positionConversationState: {
        entity:        { type: String, default: 'employee', trim: true },
        designation:   { type: String, default: null, trim: true },
        source:        { type: String, default: null, trim: true },
        updatedAt:     { type: Date, default: null },
      },
      /** Conversation entity subject — who we are talking about (persists across intents). */
      currentEntitySubject: {
        entityType:  { type: String, default: 'employee', trim: true },
        entityId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        employeeId:  { type: String, default: null, trim: true },
        empDocId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
        name:        { type: String, default: null, trim: true },
        updatedAt:   { type: Date, default: null },
      },
      /** Topic memory for manager follow-ups ("what about org chart"). */
      conversationTopic: {
        concept:            { type: String, default: null, trim: true },
        lastInterpretation: { type: String, default: null, trim: true },
        updatedAt:          { type: Date, default: null },
      },
      /** Person-scoped job application thread — applicant, operation, domain. */
      applicationQueryContext: { type: mongoose.Schema.Types.Mixed, default: null },
      /** Referral-lead query thread — candidate, referrer, sales-agent context. */
      referralLeadQueryContext: { type: mongoose.Schema.Types.Mixed, default: null },
      /** Last deterministic query domain (e.g. applications) for what-about switches. */
      lastQueryDomain: { type: String, default: null, trim: true },
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
