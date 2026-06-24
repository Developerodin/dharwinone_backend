import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as pushService from '../services/push.service.js';

const registerToken = catchAsync(async (req, res) => {
  const { token, platform, deviceName } = req.body;
  const doc = await pushService.registerPushToken(req.user.id, { token, platform, deviceName });
  res.status(httpStatus.CREATED).json({ id: doc._id.toString(), token: doc.token, platform: doc.platform });
});

const unregisterToken = catchAsync(async (req, res) => {
  await pushService.unregisterPushToken(req.user.id, req.body.token);
  res.json({ success: true });
});

export { registerToken, unregisterToken };
