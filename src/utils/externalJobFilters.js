import { EXTERNAL_JOB_SOURCES } from '../models/externalJob.model.js';

/** Same shape the other query-filter utils use (meetingQueryFilter, jobLocation.util). */
const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SOURCE_ALIASES = { 'linkedin-jobs-api': 'linkedin-job-search-api' };
const CANONICAL_SOURCES = new Set(EXTERNAL_JOB_SOURCES);

/** Case-insensitive "contains", with the user's text treated as literal. */
const contains = (term) => new RegExp(escapeRegex(term), 'i');

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A saved-at bound, or undefined when the caller sent nothing usable.
 *
 * `<input type="date">` sends a bare `YYYY-MM-DD`, which parses to midnight UTC. Used
 * as-is for the upper bound that excludes the whole day the user asked to include, so a
 * date-only `to` is pushed to the end of that day. A full timestamp is honoured exactly.
 */
const boundary = (value, endOfDay) => {
  const raw = trimmed(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  return date;
};

const savedAtRange = (options) => {
  const from = boundary(options.savedFrom, false);
  const to = boundary(options.savedTo, true);
  if (!from && !to) return undefined;
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
};

/**
 * Mongo filter for a user's saved external jobs.
 *
 * Pure — no database access — so the filtering rules can be tested without a connection.
 * Every unrecognised or blank input is dropped rather than narrowed to nothing: a filter
 * the user cannot see in the UI must never silently empty their list.
 */
export const buildSavedJobsFilter = (userId, options = {}) => {
  const filter = { savedBy: userId };

  const q = trimmed(options.q);
  if (q) {
    const re = contains(q);
    filter.$or = [{ title: re }, { company: re }];
  }

  const rawSource = trimmed(options.source);
  const source = SOURCE_ALIASES[rawSource] || rawSource;
  if (source && CANONICAL_SOURCES.has(source)) filter.source = source;

  const savedAt = savedAtRange(options);
  if (savedAt) filter.savedAt = savedAt;

  return filter;
};

/**
 * Mongo filter for a user's saved HR contacts.
 *
 * `q` spans the company too. A saved contact is remembered as "the HR person at Acme" as
 * often as by name, and a second box the user must guess between is worse than one that
 * looks everywhere. It does mean "Acme" also matches a person named Acme -- an acceptable
 * trade on a shortlist this small.
 */
export const buildSavedContactsFilter = (userId, options = {}) => {
  const filter = { userId };

  const q = trimmed(options.q);
  if (q) {
    const re = contains(q);
    filter.$or = [{ firstName: re }, { lastName: re }, { title: re }, { email: re }, { companyName: re }];
  }

  const savedAt = savedAtRange(options);
  if (savedAt) filter.savedAt = savedAt;

  return filter;
};
