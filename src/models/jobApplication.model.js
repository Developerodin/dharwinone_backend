import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const jobApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', required: true, index: true },
    status: {
      type: String,
      enum: ['Applied', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'],
      default: 'Applied',
    },
    coverLetter: { type: String, trim: true },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

jobApplicationSchema.index({ job: 1, candidate: 1 }, { unique: true });

jobApplicationSchema.plugin(toJSON);
jobApplicationSchema.plugin(paginate);

const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);

export default JobApplication;
