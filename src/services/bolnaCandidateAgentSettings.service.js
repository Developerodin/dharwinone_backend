import BolnaCandidateAgentSettings from '../models/bolnaCandidateAgentSettings.model.js';

const DEFAULT_KEY = 'default';
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

export async function getBolnaCandidateAgentSettingsDoc() {
  return BolnaCandidateAgentSettings.findOneAndUpdate(
    { key: DEFAULT_KEY },
    { $setOnInsert: { key: DEFAULT_KEY } },
    { upsert: true, new: true }
  );
}

/** Plain object for API responses. */
export async function getBolnaCandidateAgentSettings() {
  const doc = await getBolnaCandidateAgentSettingsDoc();
  return {
    extraSystemInstructions: doc.extraSystemInstructions || '',
    greetingOverride: doc.greetingOverride || '',
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
}

/** PATCH semantics: update only keys provided; empty string explicitly clears a value. */
export async function updateBolnaCandidateAgentSettings(body = {}, userId) {
  const doc = await getBolnaCandidateAgentSettingsDoc();
  if (hasOwn(body, 'extraSystemInstructions')) {
    doc.extraSystemInstructions = String(body.extraSystemInstructions ?? '');
  }
  if (hasOwn(body, 'greetingOverride')) {
    doc.greetingOverride = String(body.greetingOverride ?? '');
  }
  if (userId) doc.updatedBy = userId;
  await doc.save();
  return getBolnaCandidateAgentSettings();
}

/** Values consumed by candidate prompt rendering before each dial. */
export async function getBolnaCandidateAgentSettingsForPrompt() {
  const doc = await getBolnaCandidateAgentSettingsDoc();
  return {
    extraSystemInstructions: doc.extraSystemInstructions || '',
    greetingOverride: doc.greetingOverride || '',
  };
}
