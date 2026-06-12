import mongoose from 'mongoose';

/**
 * Normalize user-supplied id strings into unique ObjectIds; invalid entries are dropped.
 * Returns [] for nullish/empty.
 * @param {string|string[]|null|undefined} input
 * @returns {import('mongoose').Types.ObjectId[]}
 */
export function normalizeIdList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item).trim();
    if (!mongoose.Types.ObjectId.isValid(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(new mongoose.Types.ObjectId(id));
  }
  return out;
}
