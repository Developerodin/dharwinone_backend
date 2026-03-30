import mongoose from 'mongoose';
import httpStatus from 'http-status';
import ActivityLog from '../models/activityLog.model.js';
import User from '../models/user.model.js';
import Role from '../models/role.model.js';
import Impersonation from '../models/impersonation.model.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { viewerSeesHiddenUsers, getDirectoryHiddenUserIds } from '../utils/platformAccess.util.js';
import { resolveGeoForDisplay } from '../utils/ipGeo.util.js';
import { getClientIpFromRequest, parseClientSuppliedIpHeader } from '../utils/requestIp.util.js';
import { parseUserAgentDetails } from '../utils/parseUserAgent.util.js';
import { nominatimReversePlace } from '../utils/nominatimReverse.util.js';

const EXPORT_ROW_CAP = 50000;

/**
 * @param {string} s
 */
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const IP_FILTER_PATTERN = /^[0-9a-fA-F:.]+$/;

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

const CLIENT_GEO_MAX_AGE_MS = 30 * 60 * 1000;
const CLIENT_GEO_HEADER_MAX = 2048;
const PLACE_MAX_LEN = 128;

/**
 * @param {unknown} v
 * @returns {string|null}
 */
const trimClientGeoPlace = (v) => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, PLACE_MAX_LEN);
  return s || null;
};

/**
 * Optional browser location via X-Activity-Client-Geo.
 *
 * Preferred: JSON `{"ts":epochMs,"accuracy":m,"city","region","country"}` — coarse place only (no lat/lng stored).
 * JSON fallback: `{"ts","accuracy","lat","lng"|"lon"}` when reverse geocode failed on the client — server reverse-geocodes; still no coordinates persisted.
 * Legacy: `lat,lng,accuracyM,epochMs` — server reverse-geocodes then persists place names only.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ city: string|null, region: string|null, country: string|null, accuracyM: number, capturedAt: Date, source: string }|null>}
 */
const resolveClientGeoFromRequest = async (req) => {
  if (!req?.get) return null;
  const raw = req.get('x-activity-client-geo');
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > CLIENT_GEO_HEADER_MAX) return null;

  if (trimmed.startsWith('{')) {
    let o;
    try {
      o = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const ts = Number(o.ts);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (Date.now() - ts > CLIENT_GEO_MAX_AGE_MS) return null;
    const accRaw = Number(o.accuracy);
    const accuracyM =
      Number.isFinite(accRaw) && accRaw >= 0 && accRaw <= 50000 ? accRaw : 0;
    const city = trimClientGeoPlace(o.city);
    const region = trimClientGeoPlace(o.region);
    const country = trimClientGeoPlace(o.country);
    if (city || region || country) {
      return {
        city,
        region,
        country,
        accuracyM,
        capturedAt: new Date(ts),
        source: 'browser_geolocation',
      };
    }

    const lat = Number(o.lat);
    const lng = Number(o.lon ?? o.lng);
    if (
      Number.isFinite(lat) &&
      lat >= -90 &&
      lat <= 90 &&
      Number.isFinite(lng) &&
      lng >= -180 &&
      lng <= 180
    ) {
      const place = await nominatimReversePlace(lat, lng);
      if (!place) return null;
      return {
        city: place.city,
        region: place.region,
        country: place.country,
        accuracyM,
        capturedAt: new Date(ts),
        source: 'browser_geolocation',
      };
    }
    return null;
  }

  const parts = trimmed.split(',');
  if (parts.length !== 4) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  const accuracyM = Number(parts[2]);
  const ts = Number(parts[3]);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (!Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > 50000) return null;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (Date.now() - ts > CLIENT_GEO_MAX_AGE_MS) return null;

  const place = await nominatimReversePlace(lat, lng);
  if (!place) return null;
  return {
    city: place.city,
    region: place.region,
    country: place.country,
    accuracyM,
    capturedAt: new Date(ts),
    source: 'browser_geolocation',
  };
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
  const headerGeo = geoFromTrustedHeaders(req);
  const ip = getClientIpFromRequest(req);
  const clientIp = parseClientSuppliedIpHeader(req);
  const preferredForGeo = clientIp || ip;
  const resolvedGeo = resolveGeoForDisplay(preferredForGeo, headerGeo);
  const geo =
    resolvedGeo &&
    (resolvedGeo.country || resolvedGeo.region || resolvedGeo.city
      ? {
          country: resolvedGeo.country ?? null,
          region: resolvedGeo.region ?? null,
          city: resolvedGeo.city ?? null,
        }
      : null);

  const clientGeo = req ? await resolveClientGeoFromRequest(req) : null;

  const entry = {
    actor: actorId,
    action,
    entityType,
    entityId,
    metadata: sanitizeMetadata(metadata),
    ip,
    clientIp: clientIp || null,
    userAgent: req?.get?.('user-agent') || null,
    httpMethod: req?.method || null,
    httpPath: requestPathTemplate(req),
    ...(geo ? { geo } : {}),
    ...(clientGeo ? { clientGeo } : {}),
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
 * Shared Mongo filter for list + export (same contract as HTTP query).
 * @param {Object} filter - actor, action, entityType, entityId, startDate, endDate, includeAttendance, ip, q
 * @param {object | null} [viewer] - req.user; non–platform-super viewers omit logs whose actor is directory-hidden
 * @returns {Promise<Object>}
 */
const buildActivityLogMongoFilter = async (filter, viewer = null) => {
  const { startDate, endDate, includeAttendance, ip, q, ...rest } = filter;
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

  if (ip != null && String(ip).trim()) {
    const ipTrim = String(ip).trim();
    if (IP_FILTER_PATTERN.test(ipTrim)) {
      const re = new RegExp(`^${escapeRegExp(ipTrim)}`, 'i');
      const ipOr = { $or: [{ ip: re }, { clientIp: re }] };
      if (Array.isArray(mongoFilter.$and)) {
        mongoFilter.$and.push(ipOr);
      } else {
        mongoFilter.$and = [ipOr];
      }
    }
  }

  if (q != null && String(q).trim()) {
    const qTrim = String(q).trim();
    const re = new RegExp(escapeRegExp(qTrim), 'i');
    const orClause = [{ action: re }, { entityType: re }, { entityId: re }];
    if (/^[\d.:a-fA-F]{3,}$/i.test(qTrim) && qTrim.length <= 45) {
      orClause.push({ ip: re });
      orClause.push({ clientIp: re });
    }
    const qCond = { $or: orClause };
    if (Array.isArray(mongoFilter.$and)) {
      mongoFilter.$and.push(qCond);
    } else {
      mongoFilter.$and = [qCond];
    }
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

  return mongoFilter;
};

/**
 * @param {string} cell
 */
const csvEscape = (cell) => {
  const s = cell == null ? '' : String(cell);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

/**
 * Single-line summary for tools/exports: GPS place when present, else IP-derived geo.
 * @param {Record<string, unknown>} p
 * @returns {string|null}
 */
const displayLocationFromPlain = (p) => {
  const cg = p.clientGeo;
  if (cg && typeof cg === 'object') {
    const parts = [cg.city, cg.region, cg.country].filter((x) => x != null && String(x).trim());
    if (parts.length) return `${parts.map((x) => String(x).trim()).join(', ')} (GPS)`;
  }
  const g = p.geo;
  if (g && typeof g === 'object') {
    const parts = [g.city, g.region, g.country].filter((x) => x != null && String(x).trim());
    if (parts.length) return `${parts.map((x) => String(x).trim()).join(', ')} (IP approx)`;
  }
  return null;
};

/**
 * @param {Record<string, unknown>} plain
 */
const enrichPlainForClient = (plain) => {
  const withGeo = { ...plain };
  const serverIp = withGeo.ip ?? null;
  const cip = withGeo.clientIp ?? null;
  const preferred = cip || serverIp;
  withGeo.geo = resolveGeoForDisplay(preferred, withGeo.geo);
  withGeo.displayIp = cip || serverIp || null;
  withGeo.displayLocation = displayLocationFromPlain(withGeo);
  return normalizeIdsForClient(withGeo);
};

const userDisplayFromDoc = (u) => {
  if (!u) return null;
  const name = u.name != null ? String(u.name).trim() : '';
  const email = u.email != null ? String(u.email).trim() : '';
  const username = u.username != null ? String(u.username).trim() : '';
  return name || email || username || null;
};

/**
 * Fill targetUserName / roleName from DB when missing from stored metadata (legacy rows, partial writes).
 * @param {Record<string, unknown>[]} plains
 * @param {object|null} viewer - req.user
 */
const enrichActivityLogPlainsForEntityLabels = async (plains, viewer = null) => {
  if (!plains.length) return;

  const canSeeHidden = viewerSeesHiddenUsers(viewer);
  const hiddenIds = canSeeHidden ? [] : await getDirectoryHiddenUserIds();
  const hiddenSet = new Set(hiddenIds.map((id) => id.toString()));

  const userIds = new Set();
  const roleIds = new Set();
  const impIds = new Set();

  for (const row of plains) {
    const et = row.entityType;
    const eid = row.entityId != null ? String(row.entityId).trim() : '';
    if (!eid || !mongoose.Types.ObjectId.isValid(eid)) continue;
    const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};

    if (et === 'User' && !meta.targetUserName) userIds.add(eid);
    if (et === 'Role' && !meta.roleName && !meta.name) roleIds.add(eid);
    if (et === 'Impersonation' && !meta.targetUserName) impIds.add(eid);
  }

  const userLabelMap = new Map();
  if (userIds.size) {
    const users = await User.find({ _id: { $in: [...userIds] } })
      .select('name email username hideFromDirectory platformSuperUser')
      .lean();
    for (const u of users) {
      const id = u._id.toString();
      if (!canSeeHidden && (hiddenSet.has(id) || u.platformSuperUser)) {
        userLabelMap.set(id, 'Restricted user');
      } else {
        const d = userDisplayFromDoc(u);
        if (d) userLabelMap.set(id, d);
      }
    }
  }

  const roleLabelMap = new Map();
  if (roleIds.size) {
    const roles = await Role.find({ _id: { $in: [...roleIds] } }).select('name').lean();
    for (const r of roles) {
      if (r.name) roleLabelMap.set(r._id.toString(), String(r.name));
    }
  }

  const impToLabel = new Map();
  if (impIds.size) {
    const imps = await Impersonation.find({ _id: { $in: [...impIds] } }).select('impersonatedUser').lean();
    const targetIds = [...new Set(imps.map((i) => i.impersonatedUser && String(i.impersonatedUser)).filter(Boolean))];
    if (targetIds.length) {
      const targets = await User.find({ _id: { $in: targetIds } })
        .select('name email username hideFromDirectory platformSuperUser')
        .lean();
      const tuMap = new Map();
      for (const u of targets) {
        const id = u._id.toString();
        if (!canSeeHidden && (hiddenSet.has(id) || u.platformSuperUser)) {
          tuMap.set(id, 'Restricted user');
        } else {
          const d = userDisplayFromDoc(u);
          if (d) tuMap.set(id, d);
        }
      }
      for (const i of imps) {
        const iid = i._id.toString();
        const tid = i.impersonatedUser && String(i.impersonatedUser);
        const label = tid ? tuMap.get(tid) : null;
        if (label) impToLabel.set(iid, label);
      }
    }
  }

  for (const row of plains) {
    const eid = row.entityId != null ? String(row.entityId).trim() : '';
    if (!eid) continue;
    const prev = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
    const meta = { ...prev };

    if (row.entityType === 'User' && !meta.targetUserName) {
      const label = userLabelMap.get(eid);
      if (label) row.metadata = { ...meta, targetUserName: label };
    } else if (row.entityType === 'Role' && !meta.roleName && !meta.name) {
      const label = roleLabelMap.get(eid);
      if (label) row.metadata = { ...meta, roleName: label };
    } else if (row.entityType === 'Impersonation' && !meta.targetUserName) {
      const label = impToLabel.get(eid);
      if (label) row.metadata = { ...meta, targetUserName: label };
    }
  }
};

/**
 * Query activity logs with filters and pagination.
 * @param {Object} filter - actor, action, entityType, entityId, startDate, endDate, includeAttendance, ip, q
 * @param {Object} options - sortBy, limit, page
 * @param {object | null} [viewer] - req.user
 * @returns {Promise<QueryResult>}
 */
const queryActivityLogs = async (filter, options, viewer = null) => {
  const mongoFilter = await buildActivityLogMongoFilter(filter, viewer);

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
  const resultsEnriched = results.map((doc) => enrichPlainForClient(doc.toObject()));
  await enrichActivityLogPlainsForEntityLabels(resultsEnriched, viewer);
  return { results: resultsEnriched, page, limit, totalPages, totalResults };
};

/**
 * Stream CSV of activity logs (same filters as list). Enforces EXPORT_ROW_CAP.
 * @param {Object} filter
 * @param {object | null} viewer
 * @param {import('express').Response} res
 */
const streamActivityLogsCsv = async (filter, viewer, res) => {
  const mongoFilter = await buildActivityLogMongoFilter(filter, viewer);
  const total = await ActivityLog.countDocuments(mongoFilter);
  if (total > EXPORT_ROW_CAP) {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      `Export would include ${total} rows; maximum is ${EXPORT_ROW_CAP}. Narrow your filters.`
    );
  }

  const headers = [
    'id',
    'createdAt',
    'actorName',
    'actorId',
    'action',
    'entityType',
    'entityId',
    'location',
    'browserGeo',
    'ip',
    'clientIp',
    'displayIp',
    'browser',
    'os',
    'device',
    'userAgent',
    'httpMethod',
    'httpPath',
    'displayLocation',
    'metadata',
  ];
  res.write(`${headers.map(csvEscape).join(',')}\n`);

  const cursor = ActivityLog.find(mongoFilter)
    .sort('-createdAt')
    .populate({ path: 'actor', select: 'name' })
    .lean()
    .cursor();

  for await (const doc of cursor) {
    const plain = enrichPlainForClient(doc);
    const geo = plain.geo;
    const locParts = [geo?.city, geo?.region, geo?.country].filter(Boolean);
    const location = locParts.length ? locParts.join(', ') : '';
    const cg = plain.clientGeo;
    const cgParts = [cg?.city, cg?.region, cg?.country].filter(Boolean);
    const browserGeo = cgParts.length ? cgParts.join(', ') : '';
    const uaParsed = parseUserAgentDetails(plain.userAgent);
    const metaStr = JSON.stringify(plain.metadata ?? {});
    const row = [
      plain.id,
      plain.createdAt ? new Date(plain.createdAt).toISOString() : '',
      plain.actor?.name ?? '',
      plain.actor?.id ?? '',
      plain.action ?? '',
      plain.entityType ?? '',
      plain.entityId ?? '',
      location,
      browserGeo,
      plain.ip ?? '',
      plain.clientIp ?? '',
      plain.displayIp ?? '',
      uaParsed?.browser ?? '',
      uaParsed?.os ?? '',
      uaParsed?.device ?? '',
      plain.userAgent ?? '',
      plain.httpMethod ?? '',
      plain.httpPath ?? '',
      plain.displayLocation ?? '',
      metaStr,
    ].map(csvEscape);
    res.write(`${row.join(',')}\n`);
  }
  res.end();
};

export {
  createActivityLog,
  queryActivityLogs,
  sanitizeMetadata,
  buildActivityLogMongoFilter,
  streamActivityLogsCsv,
  EXPORT_ROW_CAP,
};
