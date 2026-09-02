import { normalizeIdList } from './normalizeIdList.js';

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse comma-separated or array query values into trimmed strings.
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
export function parseCommaList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Build a Mongo filter for ATS interview list/export from query (+ optional body ids).
 * Mirrors the Interviews UI filter panel: candidate/recruiter substring match,
 * status/type exact match (case-insensitive), optional title search.
 *
 * @param {Record<string, any>} query
 * @param {{ ids?: string[] }} [body]
 * @returns {Record<string, any>}
 */
export function buildMeetingsMongoFilter(query = {}, body = {}) {
  const filter = {};
  const and = [];

  const ids = normalizeIdList(body?.ids);
  if (ids.length) {
    filter._id = { $in: ids };
  }

  const title = String(query.title ?? '').trim();
  if (title) {
    and.push({ title: { $regex: escapeRegex(title), $options: 'i' } });
  }

  const statuses = parseCommaList(query.status);
  if (statuses.length) {
    and.push({
      $or: statuses.map((statusValue) => {
        const raw = statusValue.toLowerCase();
        if (raw === 'scheduled') {
          return {
            $or: [
              { status: { $regex: /^scheduled$/i } },
              { status: { $in: [null, ''] } },
              { status: { $exists: false } },
            ],
          };
        }
        return { status: { $regex: new RegExp(`^${escapeRegex(statusValue)}$`, 'i') } };
      }),
    });
  }

  const candidates = parseCommaList(query.candidate);
  if (candidates.length) {
    and.push({
      $or: candidates.map((name) => ({
        'candidate.name': { $regex: escapeRegex(name), $options: 'i' },
      })),
    });
  }

  const recruiters = parseCommaList(query.recruiter);
  if (recruiters.length) {
    and.push({
      $or: recruiters.map((name) => ({
        'recruiter.name': { $regex: escapeRegex(name), $options: 'i' },
      })),
    });
  }

  const types = parseCommaList(query.interviewType);
  if (types.length) {
    and.push({
      $or: types.map((typeValue) => ({
        interviewType: { $regex: new RegExp(`^${escapeRegex(typeValue)}$`, 'i') },
      })),
    });
  }

  /**
   * Optional scheduledAt window. Mirrors the dateFrom/dateTo pair internal meetings
   * already supports, so the two meeting surfaces filter alike.
   *
   * Both bounds are ISO INSTANTS, not calendar days — the caller has already resolved
   * its own local day to UTC. Nothing here infers a timezone, which is what keeps
   * "today" meaning the viewer's today rather than the server's.
   *
   * This predicate is what makes a "today" query bounded by TIME rather than by row
   * count. Without it the only alternative is over-fetching and filtering client-side,
   * which silently drops rows as the collection grows.
   */
  const scheduledAt = {};
  if (query.dateFrom) {
    const from = new Date(query.dateFrom);
    if (!Number.isNaN(from.getTime())) scheduledAt.$gte = from;
  }
  if (query.dateTo) {
    const to = new Date(query.dateTo);
    if (!Number.isNaN(to.getTime())) scheduledAt.$lte = to;
  }
  if (Object.keys(scheduledAt).length) {
    and.push({ scheduledAt });
  }

  if (and.length) {
    filter.$and = and;
  }

  return filter;
}
