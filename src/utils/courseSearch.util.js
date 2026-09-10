/**
 * Course catalog search matching, shared by My Courses (studentCourseQuery)
 * and Curriculum / catalog (trainingModule).
 *
 * Two rules, both case-insensitive:
 *   1. substring  — "learn" matches "Machine Learning"
 *   2. initials   — "ML" matches "Machine Learning" (word-initial letters, in order)
 *
 * Rule 2 is what makes abbreviations work. Mongo `$text` cannot do it (no acronym
 * expansion, no prefix matching), which is why the existing training_module_text_idx
 * is not used here.
 *
 * The frontend mirrors these two rules in shared/lib/course-search-match.ts so the
 * typeahead dropdown and the result grid agree. Change one, change the other.
 */

/** Longest all-letter query still treated as a possible abbreviation. */
const MAX_INITIALS_LEN = 5;

/**
 * Escape a user string for safe use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex matching titles whose consecutive word initials spell `letters`.
 * "ML" -> /\bM[\w']*[\W_]+L/i, which hits "Machine Learning" but not "Model Development".
 *
 * ponytail: consecutive words only. "MDL" will not match "Machine ... Deep Learning"
 * across a skipped word. Widen to a token-scan matcher if users ask for it.
 * @param {string} letters
 * @returns {RegExp | null}
 */
const initialsRegex = (letters) => {
  if (!/^[a-z]{2,}$/i.test(letters) || letters.length > MAX_INITIALS_LEN) return null;
  return new RegExp(`\\b${letters.split('').join("[\\w']*[\\W_]+")}`, 'i');
};

/**
 * Regexes to test a course title (and related text) against for one search query.
 * @param {string} search
 * @returns {RegExp[]} empty when the query is blank
 */
const buildCourseSearchRegexes = (search) => {
  const q = String(search ?? '').trim();
  if (!q) return [];
  const regexes = [new RegExp(escapeRegex(q), 'i')];
  const initials = initialsRegex(q);
  if (initials) regexes.push(initials);
  return regexes;
};

/**
 * True when `text` satisfies either search rule.
 * @param {string} text
 * @param {string} search
 * @returns {boolean}
 */
const courseTextMatchesSearch = (text, search) => {
  const value = String(text ?? '');
  if (!value) return false;
  return buildCourseSearchRegexes(search).some((rx) => rx.test(value));
};

export { buildCourseSearchRegexes, courseTextMatchesSearch, escapeRegex };
