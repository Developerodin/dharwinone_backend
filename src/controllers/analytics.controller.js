import catchAsync from '../utils/catchAsync.js';
import * as analyticsService from '../services/analytics.service.js';

const getTrainingAnalytics = catchAsync(async (req, res) => {
  const range = ['7d', '30d', '3m', '12m'].includes(req.query.range) ? req.query.range : undefined;
  const result = await analyticsService.default.getTrainingAnalytics({ range });
  res.send(result);
});

export default {
  getTrainingAnalytics,
};
