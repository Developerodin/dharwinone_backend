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
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** P3: explicit tenant boundary. Denormalized from job.tenantId at creation time. */
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    notes: { type: String, trim: true },
    // Bolna verification call fields
    verificationCallExecutionId: { type: String, trim: true, index: true, sparse: true },
    verificationCallInitiatedAt: { type: Date },
    verificationCallStatus: { 
      type: String, 
      enum: ['pending', 'initiated', 'completed', 'failed', 'no_answer'],
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

jobApplicationSchema.plugin(toJSON);
jobApplicationSchema.plugin(paginate);

const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);

export default JobApplication;
