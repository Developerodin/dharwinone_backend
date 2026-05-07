import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const jobTemplateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    jobDescription: { type: String, required: true, trim: true },

    /** public: all users with job template access; private: only creator (and admins). */
    visibility: {
      type: String,
      enum: ['public', 'private'],
      default: 'public',
      index: true,
    },

    // `schema.index({ createdBy: 1 })` is declared below; `index: true` here would
    // create the same single-field index twice ("Duplicate schema index" warning).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Usage tracking
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

jobTemplateSchema.index({ title: 'text', jobDescription: 'text' });
jobTemplateSchema.index({ createdBy: 1 });
jobTemplateSchema.index({ createdAt: -1 });

jobTemplateSchema.plugin(toJSON);
jobTemplateSchema.plugin(paginate);

const JobTemplate = mongoose.model('JobTemplate', jobTemplateSchema);

export default JobTemplate;
