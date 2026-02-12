import jwt from 'jsonwebtoken';
import moment from 'moment';
import httpStatus from 'http-status';
import config from '../config/config.js';
import {getUserByEmail} from './user.service.js';

import ApiError from '../utils/ApiError.js';
import { tokenTypes } from '../config/tokens.js';
import Token from '../models/token.model.js';


/**
 * Generate token
 * @param {ObjectId} userId
 * @param {Moment} expires
 * @param {string} type
 * @param {string} [secret]
 * @param {Object} [extraPayload] - optional extra fields (e.g. impersonation)
 * @returns {string}
 */
const generateToken = (userId, expires, type, secret = config.jwt.secret, extraPayload = {}) => {
  const payload = {
    sub: userId,
    iat: moment().unix(),
    exp: expires.unix(),
    type,
    ...extraPayload,
  };
  return jwt.sign(payload, secret);
};

/**
 * Save a token
 * @param {string} token
 * @param {ObjectId} userId
 * @param {Moment} expires
 * @param {string} type
 * @param {boolean} [blacklisted]
 * @param {{ userAgent?: string, ip?: string }} [options]
 * @returns {Promise<Token>}
 */
const saveToken = async (token, userId, expires, type, blacklisted = false, options = {}) => {
  const tokenDoc = await Token.create({
    token,
    user: userId,
    expires: expires.toDate(),
    type,
    blacklisted,
    userAgent: options.userAgent ?? null,
    ip: options.ip ?? null,
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
 * Get request metadata for session (userAgent, ip)
 * @param {import('express').Request} [req]
 * @returns {{ userAgent: string|null, ip: string|null }}
 */
const getRequestSessionMeta = (req) => {
  if (!req) return { userAgent: null, ip: null };
  const userAgent = typeof req.get === 'function' ? req.get('User-Agent') || null : null;
  const ip = req.ip || req.socket?.remoteAddress || (req.connection && req.connection.remoteAddress) || null;
  return { userAgent, ip };
};

/**
 * Generate auth tokens
 * @param {User} user
 * @param {import('express').Request} [req] - optional request for userAgent/ip
 * @returns {Promise<Object>}
 */
const generateAuthTokens = async (user, req = null) => {
  const { userAgent, ip } = getRequestSessionMeta(req);
  const accessTokenExpires = moment().add(config.jwt.accessExpirationMinutes, 'minutes');
  const accessToken = generateToken(user.id, accessTokenExpires, tokenTypes.ACCESS);

  const refreshTokenExpires = moment().add(config.jwt.refreshExpirationDays, 'days');
  const refreshToken = generateToken(user.id, refreshTokenExpires, tokenTypes.REFRESH);
  await saveToken(refreshToken, user.id, refreshTokenExpires, tokenTypes.REFRESH, false, { userAgent, ip });

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate(),
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate(),
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
  const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes');
  const resetPasswordToken = generateToken(user.id, expires, tokenTypes.RESET_PASSWORD);
  await saveToken(resetPasswordToken, user.id, expires, tokenTypes.RESET_PASSWORD);
  return resetPasswordToken;
};

/**
 * Generate verify email token
 * @param {User} user
 * @returns {Promise<string>}
 */
const generateVerifyEmailToken = async (user) => {
  const expires = moment().add(config.jwt.verifyEmailExpirationMinutes, 'minutes');
  const verifyEmailToken = generateToken(user.id, expires, tokenTypes.VERIFY_EMAIL);
  await saveToken(verifyEmailToken, user.id, expires, tokenTypes.VERIFY_EMAIL);
  return verifyEmailToken;
};

/**
 * Generate tokens for impersonation session.
 * Access and refresh tokens carry impersonation payload so the user is the impersonated user
 * and we know who initiated and can restore admin on stop.
 * @param {User} impersonatedUser
 * @param {string} impersonationId - Impersonation document id
 * @param {string} adminUserId
 * @param {Date} [startedAt] - when impersonation started (for audit in token)
 * @param {import('express').Request} [req] - optional request for userAgent/ip
 * @returns {Promise<Object>}
 */
const generateImpersonationTokens = async (impersonatedUser, impersonationId, adminUserId, startedAt, req = null) => {
  const { userAgent, ip } = getRequestSessionMeta(req);
  const impersonationPayload = {
    impersonation: {
      by: adminUserId,
      impersonationId,
      startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
    },
  };
  const accessTokenExpires = moment().add(config.jwt.accessExpirationMinutes, 'minutes');
  const accessToken = generateToken(
    impersonatedUser.id,
    accessTokenExpires,
    tokenTypes.ACCESS,
    config.jwt.secret,
    impersonationPayload
  );

  const refreshTokenExpires = moment().add(config.jwt.refreshExpirationDays, 'days');
  const refreshToken = generateToken(
    impersonatedUser.id,
    refreshTokenExpires,
    tokenTypes.REFRESH,
    config.jwt.secret,
    impersonationPayload
  );
  await saveToken(refreshToken, impersonatedUser.id, refreshTokenExpires, tokenTypes.REFRESH, false, { userAgent, ip });

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate(),
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate(),
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

