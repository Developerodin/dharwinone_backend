import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const sopStepSchema = new mongoose.Schema(
  {
    checkerKey: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    sortOrder: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    linkTemplate: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const candidateSopTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: 'Default onboarding' },
    version: { type: Number, required: true, min: 1 },
    isActive: { type: Boolean, default: false, index: true },
    steps: { type: [sopStepSchema], default: [] },
  },
  { timestamps: true }
);

candidateSopTemplateSchema.index({ isActive: 1, version: -1 });

candidateSopTemplateSchema.plugin(toJSON);

const CandidateSopTemplate = mongoose.model('CandidateSopTemplate', candidateSopTemplateSchema);

export default CandidateSopTemplate;
