import mongoose from 'mongoose';
import ActivityLog from '../models/activityLog.model.js';
import logger from '../config/logger.js';
import { viewerSeesHiddenUsers, getDirectoryHiddenUserIds } from '../utils/platformAccess.util.js';
import { resolveGeoForDisplay } from '../utils/ipGeo.util.js';

/**
 * Plain objects from `toObject()` keep `_id`; API clients expect `id` (same as `toJSON` on Mongoose docs).
 * @param {Record<string, unknown>} plain
 * @returns {Record<string, unknown>}
 */
const normalizeIdsForClient = (plain) => {
  const out = { ...plain };
  if (out._id != null && out.id == null) {
    out.id = out._id.toString();
    delete out._id;
  }
  if (out.actor && typeof out.actor === 'object' && out.actor !== null) {
    const a = { ...out.actor };
    if (a._id != null && a.id == null) {
      a.id = a._id.toString();
      delete a._id;
    }
    out.actor = a;
  }
  return out;
};

/**
 * Stable route template when logging inside a matched route handler.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export const requestPathTemplate = (req) => {
  if (!req) return null;
  const base = req.baseUrl || '';
  const pattern = req.route?.path != null ? req.route.path : req.path;
  let combined = `${base}${pattern || ''}`.trim();
  // When req.route is missing (some middleware stacks) base+path can be empty; pathname from originalUrl still omits query secrets.
  if (!combined && typeof req.originalUrl === 'string') {
    combined = req.originalUrl.split('?')[0].trim();
  }
  return combined || null;
};

/**
 * Country from Cloudflare (or similar) when present; do not trust client-spoofed values unless behind edge.
 * @param {import('express').Request} req
 * @returns {{ country?: string }|null}
 */
const geoFromTrustedHeaders = (req) => {
  if (!req?.get) return null;
  const country = req.get('cf-ipcountry') || req.get('CF-IPCountry');
  if (!country || country === 'XX' || country.length > 2) return null;
  return { country: country.toUpperCase() };
};

/**
 * Create an activity log entry. Do not pass sensitive PII in metadata.
 * On persistence failure, logs and resolves to null — primary request flow must not depend on success.
 * @param {string} actorId - User id who performed the action
 * @param {string} action - Action constant (e.g. ActivityActions.ROLE_CREATE)
 * @param {string} entityType - Entity type (e.g. 'Role', 'User')
 * @param {string} entityId - Id of the affected entity
 * @param {Object} [metadata] - Optional non-sensitive context (e.g. { field: 'status', newValue: 'disabled' })
 * @param {Object} [req] - Express request for ip, userAgent, method, path, geo headers
 * @returns {Promise<import('../models/activityLog.model.js').default|null>}
 */
const createActivityLog = async (actorId, action, entityType, entityId, metadata = {}, req = null) => {
  const geo = geoFromTrustedHeaders(req);
  const entry = {
    actor: actorId,
    action,
    entityType,
    entityId,
    metadata: sanitizeMetadata(metadata),
    ip: req?.ip || req?.connection?.remoteAddress || null,
    userAgent: req?.get?.('user-agent') || null,
    httpMethod: req?.method || null,
    httpPath: requestPathTemplate(req),
    ...(geo ? { geo } : {}),
  };
  try {
    return await ActivityLog.create(entry);
  } catch (err) {
    logger.error(
      { err, action, entityType, entityId, actorId },
      'activity_log_write_failed'
    );
    return null;
  }
};

/**
 * Ensure metadata does not contain sensitive fields (passwords, tokens, PII-adjacent keys).
 */
const sanitizeMetadata = (meta) => {
  if (!meta || typeof meta !== 'object') return {};
  const forbidden = [
    'password',
    'refreshtoken',
    'accesstoken',
    'email',
    'token',
    'phone',
    'phonenumber',
    'mobile',
    'ssn',
    'nationalid',
    'passport',
    'creditcard',
  ];
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    const lower = k.toLowerCase();
    if (forbidden.some((f) => lower.includes(f))) continue;
    out[k] = v;
  }
  return out;
};

/**
 * Query activity logs with filters and pagination.
 * Populates actor with id and name only (no PII like email in default response).
 * @param {Object} filter - actor, action, entityType, entityId, startDate, endDate, includeAttendance
 * @param {Object} options - sortBy, limit, page
 * @param {object | null} [viewer] - req.user; non–platform-super viewers omit logs whose actor is directory-hidden
 * @returns {Promise<QueryResult>}
 */
const queryActivityLogs = async (filter, options, viewer = null) => {
  const { startDate, endDate, includeAttendance, ...rest } = filter;
  const mongoFilter = { ...rest };

  const wantAttendance =
    includeAttendance === true ||
    includeAttendance === 'true' ||
    (mongoFilter.action && String(mongoFilter.action).startsWith('attendance.'));

  if (!wantAttendance) {
    const noAtt = { action: { $not: /^attendance\./ } };
    if (!mongoFilter.action) {
      Object.assign(mongoFilter, noAtt);
    } else {
      const actionVal = mongoFilter.action;
      delete mongoFilter.action;
      mongoFilter.$and = [{ action: actionVal }, { action: { $not: /^attendance\./ } }];
    }
  }

  if (startDate || endDate) {
    mongoFilter.createdAt = {};
    if (startDate) mongoFilter.createdAt.$gte = new Date(startDate);
    if (endDate) mongoFilter.createdAt.$lte = new Date(endDate);
  }
  if (viewer && !viewerSeesHiddenUsers(viewer)) {
    const hiddenIds = await getDirectoryHiddenUserIds();
    if (hiddenIds.length > 0) {
      const hiddenSet = new Set(hiddenIds.map((id) => id.toString()));
      if (mongoFilter.actor) {
        let actorId = mongoFilter.actor;
        if (typeof actorId === 'string' && mongoose.Types.ObjectId.isValid(actorId)) {
          actorId = new mongoose.Types.ObjectId(actorId);
        }
        if (actorId && hiddenSet.has(actorId.toString())) {
          mongoFilter._id = { $in: [] };
        }
      } else {
        mongoFilter.actor = { $nin: hiddenIds };
      }
    }
  }
  const sortBy = options.sortBy || 'createdAt:desc';
  const sort = sortBy.split(',').map((s) => {
    const [key, order] = s.split(':');
    return order === 'desc' ? `-${key}` : key;
  }).join(' ');
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;

  const [totalResults, results] = await Promise.all([
    ActivityLog.countDocuments(mongoFilter),
    ActivityLog.find(mongoFilter).sort(sort).skip(skip).limit(limit).populate({ path: 'actor', select: 'name' }),
  ]);
  const totalPages = Math.ceil(totalResults / limit);
  const resultsEnriched = results.map((doc) => {
    const plain = doc.toObject();
    plain.geo = resolveGeoForDisplay(plain.ip, plain.geo);
    return normalizeIdsForClient(plain);
  });
  return { results: resultsEnriched, page, limit, totalPages, totalResults };
};

export { createActivityLog, queryActivityLogs, sanitizeMetadata };
