import OffboardingConfig from '../models/offboardingConfig.model.js';
import { DEFAULT_OFFBOARDING_STEPS } from './offboarding.pure.js';

/** Read the singleton config; seed it with the default steps on first access. */
export const getOffboardingConfig = async () => {
  let doc = await OffboardingConfig.findOne({ key: 'singleton' });
  if (!doc) {
    doc = await OffboardingConfig.create({ key: 'singleton', steps: DEFAULT_OFFBOARDING_STEPS() });
  }
  return doc.toJSON();
};

/** Replace the editable step fields on the singleton. Steps are code-bound — callers cannot add keys. */
export const saveOffboardingConfig = async ({ steps }) => {
  const doc = await OffboardingConfig.findOneAndUpdate(
    { key: 'singleton' },
    { $set: { steps: steps || [] } },
    { new: true, upsert: true }
  );
  return doc.toJSON();
};
