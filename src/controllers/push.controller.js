import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as pushService from '../services/push.service.js';

const registerToken = catchAsync(async (req, res) => {
  const { token, platform, deviceName, soundEnabled, vibrationEnabled, notificationsEnabled } =
    req.body;
  const doc = await pushService.registerPushToken(req.user.id, {
    token,
    platform,
    deviceName,
    soundEnabled,
    vibrationEnabled,
    notificationsEnabled,
  });
  res.status(httpStatus.CREATED).json({
    id: doc._id.toString(),
    token: doc.token,
    platform: doc.platform,
    soundEnabled: doc.soundEnabled,
    vibrationEnabled: doc.vibrationEnabled,
    notificationsEnabled: doc.notificationsEnabled !== false,
  });
});

const unregisterToken = catchAsync(async (req, res) => {
  await pushService.unregisterPushToken(req.user.id, req.body.token);
  res.json({ success: true });
});

const updatePreferences = catchAsync(async (req, res) => {
  const { soundEnabled, vibrationEnabled, notificationsEnabled, token } = req.body;
  const result = await pushService.updatePushPreferences(req.user.id, {
    soundEnabled,
    vibrationEnabled,
    notificationsEnabled,
    token,
  });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

export { registerToken, unregisterToken, updatePreferences };
