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

    // Skill Tags
    skillTags: [{ type: String, trim: true }],

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
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Closed', 'Archived'],
      default: 'Active',
    },

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
  },
  { timestamps: true }
);

// Indexes for search functionality
jobSchema.index({ title: 'text', 'organisation.name': 'text', jobDescription: 'text' });
jobSchema.index({ jobType: 1 });
jobSchema.index({ location: 1 });
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
