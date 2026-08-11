// src/services/chatAssistant/personProfile/outputGuard.js
//
// Same idea as entityQuery/recordValidator.js stripFabricatedTokens: check the
// model's words against the data it was actually given, rather than trusting a
// prompt instruction to have held.

export const UNTRUSTED_BEGIN = '<<<BEGIN_UNTRUSTED>>>';
export const UNTRUSTED_END   = '<<<END_UNTRUSTED>>>';

// "salaryRange is 10-12 LPA", "salary range: 10-12 LPA" — a redacted key followed
// by a value. A bare mention plus a refusal ("isn't available") must not trip it.
function leakPattern(key) {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1[ ]?$2');
  return new RegExp(`\\b${spaced}\\b\\s*(?:is|:|=|was|of)\\s*(?!n['']?t\\b|not\\b|un)\\S`, 'i');
}

/**
 * @param {string} replyText
 * @param {{profiles: Record<string, {redacted?: string[]}>}} payload
 */
export function assertNoRedactedLeak(replyText, payload) {
  const text = String(replyText || '');
  const leaked = [];
  for (const profile of Object.values(payload?.profiles || {})) {
    for (const key of profile.redacted || []) {
      if (leakPattern(key).test(text)) leaked.push(key);
    }
  }
  return { ok: leaked.length === 0, leaked: [...new Set(leaked)] };
}

/** Fence attacker-controlled free text so the prompt can treat it as data only. */
export function delimitUntrusted(text) {
  const inner = String(text || '')
    .split(UNTRUSTED_END).join('[END]')
    .split(UNTRUSTED_BEGIN).join('[BEGIN]');
  return `${UNTRUSTED_BEGIN}\n${inner}\n${UNTRUSTED_END}`;
}
