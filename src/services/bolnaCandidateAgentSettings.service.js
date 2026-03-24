import BolnaCandidateAgentSettings from '../models/bolnaCandidateAgentSettings.model.js';

const DEFAULT_KEY = 'default';

function sanitizePlainText(value, maxLen) {
  if (value == null) return '';
  let s = String(value);
  s = s.replace(/\0/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

export async function getBolnaCandidateAgentSettingsDoc() {
  return BolnaCandidateAgentSettings.findOneAndUpdate(
    { key: DEFAULT_KEY },
    { $setOnInsert: { key: DEFAULT_KEY } },
    { upsert: true, new: true }
  );
}

/** Plain object for API responses */
export async function getBolnaCandidateAgentSettings() {
  const doc = await getBolnaCandidateAgentSettingsDoc();
  return {
    extraSystemInstructions: doc.extraSystemInstructions || '',
    greetingOverride: doc.greetingOverride || '',
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
}

/** Strips dangerous bytes and enforces max lengths before save */
export async function updateBolnaCandidateAgentSettings(body, userId) {
  const extraSystemInstructions = sanitizePlainText(body.extraSystemInstructions, 8000);
  const greetingOverride = sanitizePlainText(body.greetingOverride, 500);

  const doc = await getBolnaCandidateAgentSettingsDoc();
  doc.extraSystemInstructions = extraSystemInstructions;
  doc.greetingOverride = greetingOverride;
  if (userId) doc.updatedBy = userId;
  await doc.save();
  return getBolnaCandidateAgentSettings();
}

/** For prompt composition (no extra query if caller passes loaded doc — optional later) */
export async function getBolnaCandidateAgentSettingsForPrompt() {
  const doc = await getBolnaCandidateAgentSettingsDoc();
  return {
    extraSystemInstructions: doc.extraSystemInstructions || '',
    greetingOverride: doc.greetingOverride || '',
  };
}
