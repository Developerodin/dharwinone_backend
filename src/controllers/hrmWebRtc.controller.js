import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import moment from 'moment';
import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/config.js';
import HrmDeviceToken from '../models/hrmDeviceToken.model.js';

function requireHrmConfig() {
  const { jwtSecret, jwtIssuer, jwtAudience } = config.hrmWebRtc;
  if (!jwtSecret || !jwtIssuer || !jwtAudience) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'HRM WebRTC signaling is not configured. Set HRM_WEBRTC_JWT_SECRET, HRM_WEBRTC_JWT_ISSUER, and HRM_WEBRTC_JWT_AUDIENCE on the API server.'
    );
  }
  return { jwtSecret, jwtIssuer, jwtAudience };
}

/**
 * Short-lived JWT for the HRM WebRTC SignalR hub (admin role).
 */
const getSignalingToken = catchAsync(async (req, res) => {
  const { jwtSecret, jwtIssuer, jwtAudience } = requireHrmConfig();
  const { signalingBaseUrl, tokenExpirationMinutes } = config.hrmWebRtc;

  const expires = moment().add(tokenExpirationMinutes, 'minutes');
  const token = jwt.sign(
    {
      sub: String(req.user.id),
      email: req.user.email,
      role: 'admin',
    },
    jwtSecret,
    {
      expiresIn: `${tokenExpirationMinutes}m`,
      issuer: jwtIssuer,
      audience: jwtAudience,
    }
  );

  res.send({
    token,
    expiresAt: expires.toISOString(),
    backendUrl: signalingBaseUrl || null,
  });
});

/**
 * Mint a long-lived device JWT for the agent. Stores metadata for revocation.
 */
const createDeviceToken = catchAsync(async (req, res) => {
  const { jwtSecret, jwtIssuer, jwtAudience } = requireHrmConfig();
  const { deviceId, label, expirationDays = 365 } = req.body;

  const jti = crypto.randomUUID();
  const expiresAt = moment().add(expirationDays, 'days');

  const token = jwt.sign(
    {
      sub: deviceId,
      role: 'device',
      jti,
    },
    jwtSecret,
    {
      expiresIn: `${expirationDays}d`,
      issuer: jwtIssuer,
      audience: jwtAudience,
    }
  );

  await HrmDeviceToken.create({
    deviceId,
    tokenJti: jti,
    issuedBy: req.user.id,
    expiresAt: expiresAt.toDate(),
    label: label || '',
  });

  res.status(httpStatus.CREATED).send({
    token,
    deviceId,
    jti,
    expiresAt: expiresAt.toISOString(),
  });
});

/**
 * Revoke a device token by its JTI.
 */
const revokeDeviceToken = catchAsync(async (req, res) => {
  const { jti } = req.body;

  const record = await HrmDeviceToken.findOne({ tokenJti: jti });
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Device token not found');
  }
  if (record.revoked) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Token already revoked');
  }

  record.revoked = true;
  record.revokedAt = new Date();
  record.revokedBy = req.user.id;
  await record.save();

  res.send({ message: 'Device token revoked', jti, deviceId: record.deviceId });
});

/**
 * List all device tokens (active and revoked) for admin visibility.
 */
const listDeviceTokens = catchAsync(async (req, res) => {
  const { deviceId } = req.query;
  const filter = {};
  if (deviceId) filter.deviceId = deviceId;

  const tokens = await HrmDeviceToken.find(filter)
    .sort({ createdAt: -1 })
    .populate('issuedBy', 'name email')
    .populate('revokedBy', 'name email')
    .lean();

  res.send({
    results: tokens.map((t) => ({
      id: t._id,
      deviceId: t.deviceId,
      jti: t.tokenJti,
      label: t.label,
      issuedBy: t.issuedBy,
      expiresAt: t.expiresAt,
      revoked: t.revoked,
      revokedAt: t.revokedAt,
      revokedBy: t.revokedBy,
      createdAt: t.createdAt,
    })),
  });
});

export { getSignalingToken, createDeviceToken, revokeDeviceToken, listDeviceTokens };
