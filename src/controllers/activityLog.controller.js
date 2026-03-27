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

const getActivityLogs = catchAsync(async (req, res) => {
  const uid = String(req.user._id || req.user.id);
  const isDesignated = config.isDesignatedSuperadminEmail(req.user.email);
  const granting = getGrantingPermissions('activityLogs.read');
  const hasPrivilegedRead =
    isDesignated ||
    req.user.platformSuperUser ||
    granting.some((p) => req.authContext?.permissions?.has(p));

  const filter = hasPrivilegedRead ? pick(req.query, listFilterKeys) : { actor: uid };
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

export { getActivityLogs, exportActivityLogs, getActivityLogNetworkPreview };
