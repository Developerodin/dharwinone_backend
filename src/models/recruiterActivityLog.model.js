import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const recruiterActivityLogSchema = new mongoose.Schema(
  {
    recruiter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    activityType: {
      type: String,
      enum: ['job_posting_created', 'candidate_screened', 'interview_scheduled', 'note_added', 'feedback_added'],
      required: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    // Reference to related entities
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      index: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      index: true,
    },
    // Meeting ref optional - DHARWIN NEW has no Meeting model yet
    meeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Meeting',
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
recruiterActivityLogSchema.index({ recruiter: 1, activityType: 1, createdAt: -1 });
recruiterActivityLogSchema.index({ recruiter: 1, createdAt: -1 });
recruiterActivityLogSchema.index({ activityType: 1, createdAt: -1 });
recruiterActivityLogSchema.index({ createdAt: -1 });

recruiterActivityLogSchema.plugin(toJSON);
recruiterActivityLogSchema.plugin(paginate);

const RecruiterActivityLog = mongoose.model('RecruiterActivityLog', recruiterActivityLogSchema);

export default RecruiterActivityLog;
