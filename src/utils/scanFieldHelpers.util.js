/**
 * Pieces shared by every scanned-document extractor (EAD card, visa, and whatever
 * follows). The document-specific regexes and date formats stay in their own services —
 * only the parts that would otherwise be copied verbatim live here.
 */

/** What a vision model returns when it means "nothing here". Treated as absence, not content. */
const SENTINELS = new Set([
  '', '-', '--', 'n/a', 'na', 'none', 'null', 'undefined',
  'unknown', 'not visible', 'not readable', 'illegible',
]);

/**
 * @param {unknown} raw
 * @returns {string|null} the trimmed string, or null if it is empty or a sentinel
 */
export function cleanRaw(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return SENTINELS.has(s.toLowerCase()) ? null : s;
}

/**
 * Refuse an incoherent date pair rather than reordering it.
 *
 * Swapping would turn a misread into a record that looks entirely correct and would
 * never be questioned again, so both values are dropped and the user is told. A pair
 * that is merely in the past is fine — an expired document is exactly what HR needs
 * on file.
 *
 * ISO YYYY-MM-DD compares correctly as a string, so no Date objects are involved.
 *
 * @param {string|null} from
 * @param {string|null} to
 * @param {string} warning message to raise when the pair is impossible
 * @returns {{ from: string|null, to: string|null, warning: string|null }}
 */
export function guardDateOrder(from, to, warning) {
  if (from && to && from > to) {
    return { from: null, to: null, warning };
  }
  return { from, to, warning: null };
}
