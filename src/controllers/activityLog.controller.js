import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import config from '../config/config.js';
import { getGrantingPermissions } from '../config/permissions.js';
import * as activityLogService from '../services/activityLog.service.js';

const listFilterKeys = [
  'actor',
  'action',
  'entityType',
  'entityId',
  'startDate',
  'endDate',
  'includeAttendance',
  'ip',
  'q',
];

/**
 * Resolve the Mongo list filter from the viewer's capabilities.
 * Pure: no req/res. viewAll → all filters/all actors; filter tier → own actor + safe
 * filters; view tier → own actor only.
 * @param {{ query: object, permissions: Set<string>, isDesignated: boolean, isPlatformSuperUser: boolean, uid: string }} ctx
 * @returns {object}
 */
const resolveActivityLogListFilter = ({ query, permissions, isDesignated, isPlatformSuperUser, uid }) => {
  const has = (p) => !!(permissions && permissions.has(p));
  const viewAll =
    isDesignated ||
    isPlatformSuperUser ||
    has('activity.delete') ||
    getGrantingPermissions('activityLogs.manage').some((p) => has(p));
  const canFilter = viewAll || (has('activity.create') && has('activity.edit'));

  if (viewAll) {
    return pick(query, listFilterKeys);
  }
  if (canFilter) {
    return {
      ...pick(query, ['action', 'entityType', 'q', 'startDate', 'endDate', 'includeAttendance']),
      actor: uid,
    };
  }
  return { actor: uid };
};

const getActivityLogs = catchAsync(async (req, res) => {
  const filter = resolveActivityLogListFilter({
    query: req.query,
    permissions: req.authContext?.permissions,
    isDesignated: config.isDesignatedSuperadminEmail(req.user.email),
    isPlatformSuperUser: !!req.user.platformSuperUser,
    uid: String(req.user._id || req.user.id),
  });
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await activityLogService.queryActivityLogs(filter, options, req.user);
  res.send(result);
});

const exportActivityLogs = catchAsync(async (req, res) => {
  const filter = pick(req.query, listFilterKeys);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="activity-logs-export.csv"');
  await activityLogService.streamActivityLogsCsv(filter, req.user, res);
});

/** Server-seen client IP (for audit UI); same value stored on activity log entries as `ip`. */
const getActivityLogNetworkPreview = catchAsync(async (req, res) => {
  res.send({ ip: req.ip || null });
});

export { getActivityLogs, exportActivityLogs, getActivityLogNetworkPreview, resolveActivityLogListFilter };
