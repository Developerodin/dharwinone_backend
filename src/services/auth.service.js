import jwt from 'jsonwebtoken';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { verifyToken, generateAuthTokens, generateImpersonationTokens } from './token.service.js';
import { getUserByEmail, getUserById, updateUserById } from './user.service.js';
import Token from '../models/token.model.js';
import Impersonation from '../models/impersonation.model.js';
import ApiError from '../utils/ApiError.js';
import { tokenTypes } from '../config/tokens.js';

/**
 * Login with username and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<User>}
 */
/**
 * Login with username and password. Does not update lastLoginAt; caller should do that after issuing tokens.
 */
const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await getUserByEmail(email);
  if (!user || !(await user.isPasswordMatch(password))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect email or password');
  }
  if (user.status === 'pending') {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Your account is pending approval. An administrator must activate your account before you can sign in.');
  }
  if (user.status !== 'active') {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Account is disabled or deleted');
  }
  return user;
};

/**
 * Logout
 * @param {string} refreshToken
 * @returns {Promise}
 */
const logout = async (refreshToken) => {
  const refreshTokenDoc = await Token.findOne({ token: refreshToken, type: tokenTypes.REFRESH, blacklisted: false });
  if (!refreshTokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Not found');
  }
  await refreshTokenDoc.deleteOne();
};

/**
 * Refresh auth tokens
 * Handles both normal and impersonation refresh tokens.
 * @param {string} refreshToken
 * @param {import('express').Request} [req] - optional request for session metadata (userAgent, ip)
 * @returns {Promise<Object>}
 */
const refreshAuth = async (refreshToken, req = null) => {
  try {
    const payload = jwt.verify(refreshToken, config.jwt.secret);
    if (payload.type !== tokenTypes.REFRESH) throw new Error();

    const refreshTokenDoc = await Token.findOne({
      token: refreshToken,
      type: tokenTypes.REFRESH,
      user: payload.sub,
      blacklisted: false,
    });
    if (!refreshTokenDoc) throw new Error();

    const user = await getUserById(payload.sub);
    if (!user || user.status !== 'active') throw new Error();

    await refreshTokenDoc.deleteOne();

    if (payload.impersonation) {
      const { impersonationId, by: adminUserId, startedAt } = payload.impersonation;
      const impersonation = await Impersonation.findById(impersonationId);
      if (!impersonation || impersonation.endedAt) throw new Error();
      return generateImpersonationTokens(user, impersonationId, adminUserId, startedAt, req);
    }
    return generateAuthTokens(user, req);
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }
};

/**
 * Start impersonation: admin temporarily acts as target user.
 * Records who, whom, when. Stores admin's refresh token to restore session on stop.
 * @param {User} adminUser
 * @param {string} targetUserId
 * @param {string} adminRefreshToken
 * @returns {Promise<{ user, tokens, impersonation }>}
 */
const startImpersonation = async (adminUser, targetUserId, adminRefreshToken) => {
  const impersonatedUser = await getUserById(targetUserId);
  if (!impersonatedUser) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (impersonatedUser.status !== 'active') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot impersonate an inactive user');
  }
  if (String(impersonatedUser.id) === String(adminUser.id)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot impersonate yourself');
  }

  const impersonation = await Impersonation.create({
    adminUser: adminUser.id,
    impersonatedUser: impersonatedUser.id,
    adminRefreshToken,
  });

  const tokens = await generateImpersonationTokens(
    impersonatedUser,
    impersonation.id,
    adminUser.id,
    impersonation.startedAt,
    null
  );

  return {
    user: impersonatedUser,
    tokens,
    impersonation: {
      impersonationId: impersonation.id,
      by: adminUser.id,
      startedAt: impersonation.startedAt,
    },
  };
};

/**
 * Stop impersonation: restore admin session using stored refresh token.
 * Sets endedAt on the impersonation record for audit.
 * @param {string} impersonationId
 * @param {string} currentRefreshToken - impersonation session's refresh token (to blacklist)
 * @returns {Promise<{ user, tokens }>}
 */
const stopImpersonation = async (impersonationId, currentRefreshToken) => {
  const impersonation = await Impersonation.findById(impersonationId);
  if (!impersonation || impersonation.endedAt) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Impersonation session not found or already ended');
  }

  const adminUser = await getUserById(impersonation.adminUser);
  if (!adminUser || adminUser.status !== 'active') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Admin account no longer active');
  }

  const tokens = await refreshAuth(impersonation.adminRefreshToken);

  // Use findByIdAndUpdate so we don't run full schema validation (adminRefreshToken is required
  // on create but we intentionally unset it when ending impersonation).
  await Impersonation.findByIdAndUpdate(impersonationId, {
    $set: { endedAt: new Date() },
    $unset: { adminRefreshToken: 1 },
  }, { runValidators: false });

  await Token.findOneAndUpdate(
    { token: currentRefreshToken, type: tokenTypes.REFRESH },
    { blacklisted: true }
  );

  return {
    user: adminUser,
    tokens,
  };
};

/**
 * Reset password
 * @param {string} resetPasswordToken
 * @param {string} newPassword
 * @returns {Promise}
 */
const resetPassword = async (resetPasswordToken, newPassword) => {
  try {
    const resetPasswordTokenDoc = await verifyToken(resetPasswordToken, tokenTypes.RESET_PASSWORD);
    const user = await getUserById(resetPasswordTokenDoc.user);
    if (!user) {
      throw new Error();
    }
    await updateUserById(user.id, { password: newPassword });
    await Token.deleteMany({ user: user.id, type: tokenTypes.RESET_PASSWORD });
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Password reset failed');
  }
};

/**
 * Change password (logged-in user). Requires current password.
 * @param {string} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise}
 */
const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await getUserById(userId);
  if (!user || !(await user.isPasswordMatch(currentPassword))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Current password is incorrect');
  }
  await updateUserById(userId, { password: newPassword });
};

/**
 * Verify email
 * @param {string} verifyEmailToken
 * @returns {Promise}
 */
const verifyEmail = async (verifyEmailToken) => {
  try {
    const verifyEmailTokenDoc = await verifyToken(verifyEmailToken, tokenTypes.VERIFY_EMAIL);
    const user = await getUserById(verifyEmailTokenDoc.user);
    if (!user) {
      throw new Error();
    }
    await Token.deleteMany({ user: user.id, type: tokenTypes.VERIFY_EMAIL });
    await updateUserById(user.id, { isEmailVerified: true });
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Email verification failed');
  }
};

export {
  loginUserWithEmailAndPassword,
  logout,
  refreshAuth,
  resetPassword,
  changePassword,
  verifyEmail,
  startImpersonation,
  stopImpersonation,
};

