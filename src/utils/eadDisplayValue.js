/**
 * The EAD card number to show outside the edit form — exports, the profile email,
 * the HTML profile dump and the chat assistant.
 *
 * `ead` is the original free-text box where a human typed the card number by hand.
 * `eadCardNumber` is the validated field the card scanner writes. They are the same
 * concept, so every read-only surface prefers the validated value and falls back to
 * the legacy one, which keeps existing records exporting exactly what they did before.
 *
 * The legacy values were never audited and some may hold a USCIS# rather than a Card#,
 * which is why nothing backfills one field from the other — this fallback is read-only
 * and reversible, a backfill would not be.
 *
 * @param {{ eadCardNumber?: string, ead?: string } | null | undefined} doc
 * @returns {string} the card number, or '' when neither field is set
 */
export function eadDisplayValue(doc) {
  const scanned = String(doc?.eadCardNumber ?? '').trim();
  if (scanned) return scanned;
  return String(doc?.ead ?? '').trim();
}

export default eadDisplayValue;
