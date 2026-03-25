import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as activityLogService from '../services/activityLog.service.js';

const getActivityLogs = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['actor', 'action', 'entityType', 'entityId', 'startDate', 'endDate']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await activityLogService.queryActivityLogs(filter, options, req.user);
  res.send(result);
});

export { getActivityLogs };
