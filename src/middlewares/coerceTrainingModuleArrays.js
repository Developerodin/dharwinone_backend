/**
 * Multipart create/update often sends id lists as JSON strings, empty strings,
 * or `students[]` / `mentorsAssigned[]` repeated fields. Run before Joi.
 */

const ID_ARRAY_KEYS = ['students', 'mentorsAssigned', 'categories', 'positions'];

/**
 * Parse a multipart field into an id array (or leave already-parsed arrays).
 * @param {unknown} value
 * @returns {unknown[]}
 */
function coerceToArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[]') return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [trimmed];
    } catch (err) {
      loggerWarnParse(err, trimmed);
      return [trimmed];
    }
  }
  return [value];
}

/**
 * @param {unknown} err
 * @param {string} raw
 */
function loggerWarnParse(err, raw) {
  const message = err instanceof Error ? err.message : String(err);
  // Single ObjectId strings are expected; only log unexpected JSON.
  if (raw.startsWith('{') || raw.startsWith('[')) {
    console.warn('coerceTrainingModuleArrays: JSON parse failed', message);
  }
}

/**
 * Normalize training-module id-array fields on req.body before Joi.
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
const coerceTrainingModuleArrays = (req, _res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      next();
      return;
    }
    for (const key of ID_ARRAY_KEYS) {
      const bracketKey = `${key}[]`;
      if (req.body[key] === undefined && req.body[bracketKey] !== undefined) {
        req.body[key] = req.body[bracketKey];
      }
      delete req.body[bracketKey];
      if (req.body[key] !== undefined) {
        req.body[key] = coerceToArray(req.body[key]);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

export default coerceTrainingModuleArrays;
