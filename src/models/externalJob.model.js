import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const SOURCES = ['active-jobs-db', 'linkedin-jobs-api'];

const externalJobSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, trim: true },
    source: {
      type: String,
      enum: SOURCES,
      required: true,
      trim: true,
    },
    title: { type: String, trim: true },
    company: { type: String, trim: true },
    location: { type: String, trim: true },
    description: { type: String, trim: true },
    jobType: { type: String, trim: true },
    experienceLevel: { type: String, trim: true },
    isRemote: { type: Boolean, default: false },
    salaryMin: { type: Number },
    salaryMax: { type: Number },
    salaryCurrency: { type: String, trim: true },
    platformUrl: { type: String, trim: true },
    postedAt: { type: Date },
    timePosted: { type: String, trim: true },
    savedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    savedAt: { type: Date, default: Date.now, index: true },
    publishedJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

externalJobSchema.index({ externalId: 1, source: 1, savedBy: 1 }, { unique: true });
externalJobSchema.index({ savedBy: 1 });
externalJobSchema.index({ savedAt: -1 });

externalJobSchema.plugin(toJSON);
externalJobSchema.plugin(paginate);

const ExternalJob = mongoose.model('ExternalJob', externalJobSchema);

export default ExternalJob;
