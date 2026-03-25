import mongoose from 'mongoose';
import ActivityLog from '../models/activityLog.model.js';
import { viewerSeesHiddenUsers, getDirectoryHiddenUserIds } from '../utils/platformAccess.util.js';

/**
 * Create an activity log entry. Do not pass sensitive PII in metadata.
 * @param {string} actorId - User id who performed the action
 * @param {string} action - Action constant (e.g. ActivityActions.ROLE_CREATE)
 * @param {string} entityType - Entity type (e.g. 'Role', 'User')
 * @param {string} entityId - Id of the affected entity
 * @param {Object} [metadata] - Optional non-sensitive context (e.g. { field: 'status', newValue: 'disabled' })
 * @param {Object} [req] - Express request for ip and userAgent
 * @returns {Promise<ActivityLog>}
 */
const createActivityLog = async (actorId, action, entityType, entityId, metadata = {}, req = null) => {
  const entry = {
    actor: actorId,
    action,
    entityType,
    entityId,
    metadata: sanitizeMetadata(metadata),
    ip: req?.ip || req?.connection?.remoteAddress || null,
    userAgent: req?.get?.('user-agent') || null,
  };
  return ActivityLog.create(entry);
};

/**
 * Ensure metadata does not contain sensitive fields (passwords, tokens, full PII).
 */
const sanitizeMetadata = (meta) => {
  if (!meta || typeof meta !== 'object') return {};
  const forbidden = ['password', 'refreshToken', 'accessToken', 'email', 'token'];
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (forbidden.some((f) => k.toLowerCase().includes(f))) continue;
    out[k] = v;
  }
  return out;
};

/**
 * Query activity logs with filters and pagination.
 * Populates actor with id and name only (no PII like email in default response).
 * @param {Object} filter - actor, action, entityType, entityId, startDate, endDate
 * @param {Object} options - sortBy, limit, page
 * @param {object | null} [viewer] - req.user; non–platform-super viewers omit logs whose actor is directory-hidden
 * @returns {Promise<QueryResult>}
 */
const queryActivityLogs = async (filter, options, viewer = null) => {
  const { startDate, endDate, ...rest } = filter;
  const mongoFilter = { ...rest };
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
  return { results, page, limit, totalPages, totalResults };
};

export { createActivityLog, queryActivityLogs };


