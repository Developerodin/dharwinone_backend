import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const stepSchema = new mongoose.Schema(
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

// Singleton: exactly one document. `key` is the uniqueness anchor.
const offboardingConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    steps: { type: [stepSchema], default: [] },
  },
  { timestamps: true }
);

offboardingConfigSchema.plugin(toJSON);

const OffboardingConfig = mongoose.model('OffboardingConfig', offboardingConfigSchema);

export default OffboardingConfig;
