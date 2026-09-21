import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';
import { APPLICATION_STATUSES } from '../constants/atsPipeline.js';

const jobApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    /**
     * Universal applicant user identity — set on creation from Employee.owner of the
     * applying candidate. NULL for synthetic offer-letter standalone applications
     * (no real applicant). NEVER set to the creator/recruiter/admin. Drives dedupe
     * and email resolution.
     */
    applicantUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: 'Applied',
    },
    coverLetter: { type: String, trim: true },
    /** Immutable resume file captured at apply time (versioned slot snapshot). */
    submittedResume: {
      slot: { type: String, trim: true },
      version: { type: Number },
      key: { type: String, trim: true },
      documentUrl: { type: String, trim: true },
      originalName: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      size: { type: Number },
      capturedAt: { type: Date },
    },
    /**
     * Immutable cover-letter file captured at apply time. Optional: absent when the applicant
     * sent no cover letter, which is why this is not folded into `submittedResume`'s shape.
     * `coverLetter` above is the legacy plain-text field and is a different thing.
     */
    submittedCoverLetter: {
      slot: { type: String, trim: true },
      version: { type: Number },
      key: { type: String, trim: true },
      documentUrl: { type: String, trim: true },
      originalName: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      size: { type: Number },
      capturedAt: { type: Date },
    },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** P3: explicit tenant boundary. Denormalized from job.tenantId at creation time. */
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /**
     * Monotonic allocator for Meeting.round.index on this application. Only ever
     * incremented — a cancelled round's number is never reissued, so two live
     * rounds can never share an index (audit M3).
     *
     * 0 / missing means "never allocated". allocateRoundIndex seeds it once from the
     * highest index already present on this application's meetings, so applications
     * that predate this field keep numbering where their history left off.
     */
    roundCounter: { type: Number, default: 0 },
    /**
     * The job's interview round sequence, frozen when this application's FIRST round was
     * scheduled. Empty means "no plan was in force" — the state of every application that
     * predates this field, and of any application whose job plans no rounds. Readers must
     * treat empty as "fall back to the pre-plan rule" (audit R3).
     *
     * Frozen, not read live from the Job, because the Job is shared by every applicant: a
     * recruiter extending a 3-round plan to 5 would otherwise retroactively add two rounds
     * to a candidate who was one round from an offer (audit R7).
     *
     * First write copies the sequence AND the rubric then in force (templateId, name,
     * criteria). Later template edits must not rewrite yesterday's evaluation. Meetings
     * still copy rubricSnapshot at schedule; when this snapshot already has criteria,
     * schedule prefers that copy.
     */
    roundPlanSnapshot: {
      capturedAt: { type: Date, default: null },
      rounds: [
        {
          _id: false,
          key: { type: String, required: true, trim: true },
          label: { type: String, required: true, trim: true },
          roundType: { type: String, default: null },
          templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'RubricTemplate', default: null },
          templateName: { type: String, trim: true, default: null },
          criteria: [
            {
              _id: false,
              key: { type: String, trim: true },
              label: { type: String, trim: true },
              weight: { type: Number },
              scaleMin: { type: Number },
              scaleMax: { type: Number },
            },
          ],
        },
      ],
    },
    notes: { type: String, trim: true },
    // Bolna verification call fields
    verificationCallExecutionId: { type: String, trim: true, index: true, sparse: true },
    verificationCallInitiatedAt: { type: Date },
    verificationCallStatus: {
      type: String,
      enum: ['pending', 'initiated', 'completed', 'failed', 'no_answer', 'withdrawn'],
    },
  },
  { timestamps: true }
);

// B12 doc: One application per (job, candidate) — DB-enforced. A re-apply by the same candidate
// to the same job is rejected at the User layer (account-exists 409) and would otherwise hit this
// E11000 index violation. Intentional — pipeline status transitions act on the existing row.
jobApplicationSchema.index({ job: 1, candidate: 1 }, { unique: true });
// P3: tenant-safe compound indexes for scoped list/count/search queries.
jobApplicationSchema.index({ tenantId: 1, candidate: 1 });
jobApplicationSchema.index({ tenantId: 1, appliedBy: 1 });

// toJSON.plugin strips the raw `createdAt` from serialized output, so the UI never sees the
// application date. Expose it via a virtual (read from createdAt) that survives the strip.
// Set virtuals BEFORE plugin: the plugin Object.assign-merges its transform onto this option.
jobApplicationSchema.virtual('appliedAt').get(function getAppliedAt() {
  return this.createdAt;
});
jobApplicationSchema.set('toJSON', { virtuals: true });

jobApplicationSchema.plugin(toJSON);
jobApplicationSchema.plugin(paginate);

const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);

export default JobApplication;
