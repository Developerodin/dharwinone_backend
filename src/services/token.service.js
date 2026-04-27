import jwt from 'jsonwebtoken';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { getUserByEmail } from './user.service.js';

import ApiError from '../utils/ApiError.js';
import { tokenTypes } from '../config/tokens.js';
import Token from '../models/token.model.js';
import { getClientIpFromRequest, parseClientSuppliedIpHeader } from '../utils/requestIp.util.js';

const nowUnix = () => Math.floor(Date.now() / 1000);

const addMinutes = (base, minutes) => {
  const d = new Date(base);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
};

const addDays = (base, days) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {Date} expiresAt
 * @param {string} type
 * @param {string} [secret]
 * @param {Object} [extraPayload]
 * @returns {string}
 */
const generateToken = (userId, expiresAt, type, secret = config.jwt.secret, extraPayload = {}) => {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const payload = {
    sub: userId,
    iat: nowUnix(),
    exp,
    type,
    ...extraPayload,
  };
  return jwt.sign(payload, secret);
};

/**
 * @param {string} token
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {Date} expires
 * @param {string} type
 * @param {boolean} [blacklisted]
 * @param {{ userAgent?: string, ip?: string, clientIp?: string|null }} [options]
 */
const saveToken = async (token, userId, expires, type, blacklisted = false, options = {}) => {
  const expiresDate = expires instanceof Date ? expires : new Date(expires);
  const tokenDoc = await Token.create({
    token,
    user: userId,
    expires: expiresDate,
    type,
    blacklisted,
    userAgent: options.userAgent ?? null,
    ip: options.ip ?? null,
    clientIp: options.clientIp ?? null,
  });
  return tokenDoc;
};

/**
 * Verify token and return token doc (or throw an error if it is not valid)
 * @param {string} token
 * @param {string} type
 * @returns {Promise<Token>}
 */
const verifyToken = async (token, type) => {
  const payload = jwt.verify(token, config.jwt.secret);
  const tokenDoc = await Token.findOne({ token, type, user: payload.sub, blacklisted: false });
  if (!tokenDoc) {
    throw new Error('Token not found');
  }
  return tokenDoc;
};

/**
 * Get request metadata for session (userAgent, server ip, optional x-client-ip)
 * @param {import('express').Request} [req]
 * @returns {{ userAgent: string|null, ip: string|null, clientIp: string|null }}
 */
const getRequestSessionMeta = (req) => {
  if (!req) return { userAgent: null, ip: null, clientIp: null };
  const userAgent = typeof req.get === 'function' ? req.get('User-Agent') || null : null;
  const ip = getClientIpFromRequest(req);
  const clientIp = parseClientSuppliedIpHeader(req);
  return { userAgent, ip, clientIp };
};

/**
 * Generate auth tokens
 * @param {User} user
 * @param {import('express').Request} [req] - optional request for userAgent/ip
 * @returns {Promise<Object>}
 */
const generateAuthTokens = async (user, req = null) => {
  const { userAgent, ip, clientIp } = getRequestSessionMeta(req);
  const accessTokenExpires = addMinutes(new Date(), config.jwt.accessExpirationMinutes);
  const accessToken = generateToken(user.id, accessTokenExpires, tokenTypes.ACCESS);

  const refreshTokenExpires = addDays(new Date(), config.jwt.refreshExpirationDays);
  const refreshToken = generateToken(user.id, refreshTokenExpires, tokenTypes.REFRESH);
  await saveToken(refreshToken, user.id, refreshTokenExpires, tokenTypes.REFRESH, false, { userAgent, ip, clientIp });

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires,
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires,
    },
  };
};

/**
 * Generate reset password token
 * @param {string} email
 * @returns {Promise<string>}
 */
const generateResetPasswordToken = async (email) => {
  const user = await getUserByEmail(email);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No users found with this email');
  }
  const expires = addMinutes(new Date(), config.jwt.resetPasswordExpirationMinutes);
  const resetPasswordToken = generateToken(user.id, expires, tokenTypes.RESET_PASSWORD);
  await saveToken(resetPasswordToken, user.id, expires, tokenTypes.RESET_PASSWORD);
  return resetPasswordToken;
};

/**
 * Generate verify email token (JWT `exp` + persisted `Token.expires`; keep both aligned).
 * @param {User} user
 * @returns {Promise<string>}
 */
const generateVerifyEmailToken = async (user) => {
  const expires = addMinutes(new Date(), config.jwt.verifyEmailExpirationMinutes);
  const verifyEmailToken = generateToken(user.id, expires, tokenTypes.VERIFY_EMAIL);
  await saveToken(verifyEmailToken, user.id, expires, tokenTypes.VERIFY_EMAIL);
  return verifyEmailToken;
};

/**
 * Generate tokens for impersonation session.
 * @param {User} impersonatedUser
 * @param {string} impersonationId - Impersonation document id
 * @param {string} adminUserId
 * @param {Date} [startedAt] - when impersonation started (for audit in token)
 * @param {import('express').Request} [req] - optional request for userAgent/ip
 * @returns {Promise<Object>}
 */
const generateImpersonationTokens = async (impersonatedUser, impersonationId, adminUserId, startedAt, req = null) => {
  const { userAgent, ip, clientIp } = getRequestSessionMeta(req);
  const impersonationPayload = {
    impersonation: {
      by: adminUserId,
      impersonationId,
      startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
    },
  };
  const accessTokenExpires = addMinutes(new Date(), config.jwt.accessExpirationMinutes);
  const accessToken = generateToken(
    impersonatedUser.id,
    accessTokenExpires,
    tokenTypes.ACCESS,
    config.jwt.secret,
    impersonationPayload
  );

  const refreshTokenExpires = addDays(new Date(), config.jwt.refreshExpirationDays);
  const refreshToken = generateToken(
    impersonatedUser.id,
    refreshTokenExpires,
    tokenTypes.REFRESH,
    config.jwt.secret,
    impersonationPayload
  );
  await saveToken(refreshToken, impersonatedUser.id, refreshTokenExpires, tokenTypes.REFRESH, false, {
    userAgent,
    ip,
    clientIp,
  });

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires,
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires,
    },
  };
};

/**
 * Get active sessions (refresh tokens) for a user for /auth/me.
 * @param {import('mongoose').Types.ObjectId} userId
 * @returns {Promise<Array<{ id: string, userAgent: string|null, ip: string|null, createdAt: Date, expires: Date }>>}
 */
const getSessionsForUser = async (userId) => {
  const docs = await Token.find({
    user: userId,
    type: tokenTypes.REFRESH,
    blacklisted: false,
  })
    .select('userAgent ip expires createdAt')
    .sort('-createdAt')
    .lean();
  return docs.map((d) => ({
    id: d._id.toString(),
    userAgent: d.userAgent ?? null,
    ip: d.ip ?? null,
    createdAt: d.createdAt,
    expires: d.expires,
  }));
};

export {
  generateToken,
  saveToken,
  verifyToken,
  generateAuthTokens,
  generateImpersonationTokens,
  generateResetPasswordToken,
  generateVerifyEmailToken,
  getSessionsForUser,
};
