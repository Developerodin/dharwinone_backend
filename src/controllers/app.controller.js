import catchAsync from '../utils/catchAsync.js';
import config from '../config/config.js';

export const getVersion = catchAsync(async (_req, res) => {
  res.json({
    latestVersion: config.app.latestVersion,
  });
});
