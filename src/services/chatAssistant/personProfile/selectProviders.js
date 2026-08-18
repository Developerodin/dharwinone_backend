// src/services/chatAssistant/personProfile/selectProviders.js

import { PROVIDERS, PROVIDER_PRECEDENCE } from './providers/index.js';

/**
 * Role slugs -> the providers to run, precedence-ordered, with same-document
 * duplicates collapsed.
 *
 * Employee and Candidate bind the same store and key. Running both would project
 * one physical document under two namespaces, and the weaker namespace is cheap
 * to obtain (candidates.read is granted by interviews.read). Collapse first.
 *
 * @param {string[]} roleSlugs
 * @returns {object[]}
 */
export function selectProviders(roleSlugs = []) {
  const wanted = new Set(roleSlugs.map((s) => String(s).toLowerCase()));
  const ordered = PROVIDER_PRECEDENCE
    .filter((slug) => wanted.has(slug))
    .map((slug) => PROVIDERS[slug])
    .filter(Boolean);

  const seenStores = new Set();
  const out = [];
  for (const p of ordered) {
    const stamp = `${p.store?.modelName ?? p.store}:${p.key}`;
    if (seenStores.has(stamp)) continue;
    seenStores.add(stamp);
    out.push(p);
  }
  return out;
}
