/**
 * Canonicalises an email for equality matching: coerces to string, trims, lowercases.
 * Returns '' for null/undefined.
 * @param {*} s
 * @returns {string}
 */
export const normalizeEmail = (s) => String(s == null ? '' : s).trim().toLowerCase();

export default normalizeEmail;
