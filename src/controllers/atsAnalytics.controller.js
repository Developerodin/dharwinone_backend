import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import atsAnalyticsService from '../services/atsAnalytics.service.js';

const VALID_RANGES = ['7d', '30d', '3m', '12m'];
const ALLOWED_DRILL_TYPES = ['applicationStatus', 'jobStatus', 'jobType', 'applicationFunnel'];

const getAtsAnalytics = catchAsync(async (req, res) => {
  const range = VALID_RANGES.includes(req.query.range) ? req.query.range : undefined;
  const result = await atsAnalyticsService.getAtsAnalytics({ range }, req.user);
  res.send(result);
});

const drillDown = catchAsync(async (req, res) => {
  const { type, value, page = 1, limit = 20 } = req.query;
  if (!ALLOWED_DRILL_TYPES.includes(type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid drill type');
  }
  const result = await atsAnalyticsService.getDrillDown(
    { type, value, page: Number(page), limit: Number(limit) },
    req.user
  );
  res.send(result);
});

const applicationsOverTimeByCandidates = catchAsync(async (req, res) => {
  const candidateIdsStr = req.query.candidateIds || '';
  const candidateIds = candidateIdsStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const result = await atsAnalyticsService.getApplicationsOverTimeByCandidates(candidateIds);
  res.send(result);
});

export default {
  getAtsAnalytics,
  drillDown,
  applicationsOverTimeByCandidates,
};
