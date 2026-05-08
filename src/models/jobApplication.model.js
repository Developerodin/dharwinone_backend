import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const jobApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    status: {
      type: String,
      enum: ['Applied', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'],
      default: 'Applied',
    },
    coverLetter: { type: String, trim: true },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
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

jobApplicationSchema.plugin(toJSON);
jobApplicationSchema.plugin(paginate);

const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);

export default JobApplication;
