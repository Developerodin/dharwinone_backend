import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const JOB_TYPE_VALUES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'];

const jobAlertSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    enabled: { type: Boolean, default: false },
    criteria: {
      jobTypes: [{ type: String, enum: JOB_TYPE_VALUES }],
      location: { type: String, trim: true, default: '' },
      experienceLevel: {
        type: String,
        enum: ['Entry Level', 'Mid Level', 'Senior Level', 'Executive', ''],
        default: '',
      },
      jobOrigin: { type: String, enum: ['internal', 'external', ''], default: '' },
      search: { type: String, trim: true, default: '' },
    },
    channels: {
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

jobAlertSubscriptionSchema.plugin(toJSON);

const JobAlertSubscription = mongoose.model('JobAlertSubscription', jobAlertSubscriptionSchema);

export default JobAlertSubscription;
