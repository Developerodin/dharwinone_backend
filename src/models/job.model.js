import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const organisationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    website: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    description: { type: String, trim: true },
    // Company-information fields surfaced in the job details panel.
    // Optional, additive — older jobs without these simply render blank.
    industry: { type: String, trim: true },
    founded: { type: Number, min: 1800, max: 2100 },
    companySize: {
      type: String,
      enum: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'],
      trim: true,
    },
  },
  { _id: false }
);

const jobSchema = new mongoose.Schema(
  {
    // Organisation Details
    organisation: { type: organisationSchema, required: true },

    // Job Details
    title: { type: String, required: true, trim: true },
    jobDescription: { type: String, required: true, trim: true },
    jobType: {
      type: String,
      enum: ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'],
      required: true,
    },
    location: {
      type: String,
      required: true,
      trim: true,
    },
    /** Normalized geographic metadata for hierarchical browse filters; display uses `location`. */
    locationMeta: {
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      countryCode: { type: String, trim: true, uppercase: true },
    },

    // Skill Tags (flat list for quick filtering)
    skillTags: [{ type: String, trim: true }],

    // Structured skill requirements with level and required flag
    skillRequirements: [
      {
        name: { type: String, required: true, trim: true },
        level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'] },
        required: { type: Boolean, default: true },
        _id: false,
      },
    ],

    // Additional Fields
    salaryRange: {
      min: { type: Number },
      max: { type: Number },
      currency: { type: String, default: 'USD', trim: true },
    },
    experienceLevel: {
      type: String,
      enum: ['Entry Level', 'Mid Level', 'Senior Level', 'Executive'],
      trim: true,
    },
    // Numeric experience range (years). Single source of truth for the
    // "Experience" string rendered across listing + details. Optional —
    // falls back to experienceLevel bucket when absent (see jobMappers).
    minExperience: { type: Number, min: 0, max: 80 },
    maxExperience: { type: Number, min: 0, max: 80 },
    // Number of openings / vacancies for this job posting.
    // Optional — older jobs without this remain valid; UI falls back to "—".
    vacancies: { type: Number, min: 1, default: 1 },
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Closed', 'Archived'],
      default: 'Active',
    },
    /**
     * True only when the vacancy auto-close tick closed this job. It is what lets raising the
     * vacancy count reopen the posting, and what stops that reopen from ever touching a job a
     * human closed deliberately.
     */
    autoClosedForVacancies: { type: Boolean, default: false },
    /**
     * When the owner was told this job's openings are full. Null means "not told yet", which is what
     * the tick claims against so two overlapping ticks cannot mail twice. Raising `vacancies` nulls
     * it again, so a job that refills after the count goes up notifies a second time.
     */
    vacancyFilledNotifiedAt: { type: Date, default: null },
    /** Optional last date to accept applications; shown on browse listings when set. */
    applicationDeadline: { type: Date, default: null },

    /**
     * This job's interview rubrics. Empty — the default, and the state of every job that
     * predates this field — means the job has no opinion, and scoring falls through to the
     * template rungs in rubricTemplate.service.js resolveRubricForRound.
     *
     * A row targets one round type, or `roundType: null` for the job's own default, and
     * names EITHER a template to reuse or its own criteria. Validation enforces exactly one
     * of the two; nothing here can, which is why rubricAssignmentsError runs on every
     * write (audit J5).
     *
     * `templateId` is a REFERENCE: editing that template changes what this job scores
     * against, which is the point of a template. `criteria` is a COPY owned by this job.
     * Either way the resolved result is snapshotted onto the interview at schedule time,
     * so changing any of it can never restate a round that already happened (audit J2).
     *
     * The job form's toggle is DERIVED from this array being non-empty. There is
     * deliberately no separate boolean — two fields could disagree, and then "does this job
     * have its own rubric" would have two answers.
     */
    rubricAssignments: [
      {
        _id: false,
        /** null = this job's default row. At most one null row; enforced in validation. */
        roundType: { type: String, default: null },
        templateId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'RubricTemplate',
          default: null,
        },
        criteria: [
          {
            _id: false,
            key: { type: String, required: true, trim: true },
            label: { type: String, required: true, trim: true },
            weight: { type: Number, required: true },
            scaleMin: { type: Number, default: 1 },
            scaleMax: { type: Number, default: 5 },
          },
        ],
      },
    ],

    // Template Reference (if created from template)
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobTemplate',
    },

    // Ownership
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** P3: explicit tenant boundary. Populated from creator's adminId at creation time. */
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // Job posting verification call (Bolna)
    verificationCallExecutionId: { type: String, default: null, index: true },
    verificationCallInitiatedAt: { type: Date, default: null },

    // Internal vs mirrored external listing (browse)
    jobOrigin: {
      type: String,
      enum: ['internal', 'external'],
      default: 'internal',
      index: true,
    },
    externalRef: {
      externalId: { type: String, trim: true },
      source: { type: String, trim: true },
    },
    externalPlatformUrl: { type: String, trim: true },

    // Auto-fetch ingestion scope (null for manually-saved/internal jobs -- those
    // are never touched by stale cleanup, see externalJobAutoFetch.service.js).
    autoFetchConfigId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExternalJobAutoFetchConfig',
      default: null,
      index: true,
    },
    /** Last time an auto-fetch sync re-discovered this job; stale = missing from the latest successful run. */
    lastSeenAt: { type: Date, default: null },

    // Per-user bookmark notes. visibility='public' visible to all who can read the job;
    // 'private' visible only to the note's owner.
    bookmarks: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        note: { type: String, required: true, trim: true, maxlength: 2000 },
        visibility: { type: String, enum: ['public', 'private'], default: 'public' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

// Indexes for search functionality
jobSchema.index({ title: 'text', 'organisation.name': 'text', jobDescription: 'text' });
jobSchema.index({ jobType: 1 });
jobSchema.index({ location: 1 });
jobSchema.index({ 'locationMeta.countryCode': 1 });
jobSchema.index({ 'locationMeta.countryCode': 1, 'locationMeta.state': 1 });
jobSchema.index({ 'locationMeta.countryCode': 1, 'locationMeta.city': 1 });
jobSchema.index({ status: 1 });
jobSchema.index({ skillTags: 1 });
jobSchema.index({ createdAt: -1 });
jobSchema.index({ status: 1, jobOrigin: 1 });

// One published Job per external listing (global)
jobSchema.index(
  { 'externalRef.externalId': 1, 'externalRef.source': 1 },
  {
    unique: true,
    partialFilterExpression: {
      jobOrigin: 'external',
      'externalRef.externalId': { $exists: true, $type: 'string' },
      'externalRef.source': { $exists: true, $type: 'string' },
    },
  }
);

jobSchema.plugin(toJSON);
jobSchema.plugin(paginate);
// P3: tenant-safe compound indexes.
jobSchema.index({ tenantId: 1, createdBy: 1 });
jobSchema.index({ tenantId: 1, status: 1 });
/**
 * Reverse lookup: which jobs reference a given rubric template.
 *
 * Needed by the archive guard and by the "used by N jobs" count on the template list
 * (audit J3, J15). Sparse, because most jobs have no assignments at all.
 *
 * autoIndex is OFF in production (config.js), so shipping this file does NOT build it.
 * It needs a deliberate index-creation step on deploy. Correctness does not depend on it;
 * only the latency of those two lookups does.
 */
jobSchema.index({ 'rubricAssignments.templateId': 1 }, { sparse: true });

// Include createdAt (and updatedAt) in API response so Posted Date is available in the UI
const originalJobToJSON = jobSchema.options.toJSON?.transform;
jobSchema.options.toJSON = jobSchema.options.toJSON || {};
jobSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalJobToJSON) originalJobToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

const Job = mongoose.model('Job', jobSchema);

export default Job;
