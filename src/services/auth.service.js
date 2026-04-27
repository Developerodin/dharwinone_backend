import jwt from 'jsonwebtoken';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { verifyToken, generateAuthTokens, generateImpersonationTokens } from './token.service.js';
import { getUserByEmail, getUserById, updateUserById } from './user.service.js';
import Token from '../models/token.model.js';
import User from '../models/user.model.js';
import Role from '../models/role.model.js';
import Employee from '../models/employee.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Impersonation from '../models/impersonation.model.js';
import ApiError from '../utils/ApiError.js';
import { tokenTypes } from '../config/tokens.js';
import { userHasCandidateRole, STAFF_ROLE_NAMES_SKIP_PUBLIC_CANDIDATE_VERIFY } from '../utils/roleHelpers.js';
import { getResignStatusByOwnerId } from './employee.service.js';
import logger from '../config/logger.js';
import { getRoleByName } from './role.service.js';
import {
  buildVerifyEmailUpdatePlan,
  buildVerifyEmailAggregationPipeline,
} from './auth.verifyEmailUpdate.js';

/**
 * Internal/staff users must not receive public-candidate auto-activation (status/role) on email verify.
 * Same role-name blocklist as duplicate candidate registration (D-02).
 * @param {import('mongoose').Document|object|null|undefined} user
 * @returns {Promise<boolean>}
 */
const userIsStaffForVerifyEmail = async (user) => {
  if (user?.platformSuperUser) return true;
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasStaff = await Role.exists({
    _id: { $in: roleIds },
    name: { $in: STAFF_ROLE_NAMES_SKIP_PUBLIC_CANDIDATE_VERIFY },
    status: 'active',
  });
  return !!hasStaff;
};

/**
 * Share-candidate invite users created before `registrationSource` + Candidate `roleIds` could verify
 * but stay pending. Repair when they open the verify page again (JWT/consumed token idempotent path).
 * @param {import('mongoose').Document} user
 */
async function healPendingCandidateAfterStaleVerify(user) {
  if (!user?.isEmailVerified || user.status !== 'pending') return;

  const noOrEmptyRoles = !user.roleIds || user.roleIds.length === 0;
  if (!noOrEmptyRoles) return;
  if (user.registrationSource === 'public_generic') return;

  if (await userIsStaffForVerifyEmail(user)) return;

  const hasJobApplicationAsApplicant = await JobApplication.exists({ appliedBy: user._id });
  const ownedCandidateProfile = await Employee.exists({ owner: user._id });
  const eligibleForCandidateAutoActivate =
    user.registrationSource === 'public_candidate' ||
    (user.registrationSource !== 'public_generic' &&
      noOrEmptyRoles &&
      (!!hasJobApplicationAsApplicant || !!ownedCandidateProfile));

  if (!eligibleForCandidateAutoActivate) return;

  const candidateRole = await getRoleByName('Candidate');
  const studentRole = await getRoleByName('Student');
  if (!candidateRole) {
    logger.warn('healPendingCandidateAfterStaleVerify: Candidate role not configured');
    return;
  }

  const setRegistrationSourcePublicCandidate =
    user.registrationSource !== 'public_candidate' && user.registrationSource !== 'public_generic';

  const plan = buildVerifyEmailUpdatePlan(
    {
      status: user.status,
      eligibleForCandidateAutoActivate,
      setRegistrationSourcePublicCandidate,
      roleIds: user.roleIds,
    },
    {
      skipStaffAutoActivate: false,
      candidateRoleId: candidateRole._id,
      studentRoleId: studentRole ? studentRole._id : null,
    }
  );

  const pipe = buildVerifyEmailAggregationPipeline(plan);
  if (pipe) {
    await User.findByIdAndUpdate(user._id, pipe);
  } else {
    await User.findByIdAndUpdate(user._id, { $set: plan.scalarSet });
  }

  const { pendingToActive } = plan;

  if (pendingToActive && user.email) {
    const { sendCandidateAccountActivationEmail } = await import('./email.service.js');
    sendCandidateAccountActivationEmail(user.email, user.name).catch((err) => {
      logger.warn(`healPendingCandidateAfterStaleVerify: activation email failed ${err?.message || err}`);
    });
    const cfg = (await import('../config/config.js')).default;
    const signInUrl = `${(cfg?.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '')}/authentication/sign-in/`;
    const { notify } = await import('./notification.service.js');
    notify(user.id || user._id, {
      type: 'account',
      title: 'Your account has been activated',
      message: 'You can now sign in.',
      link: signInUrl,
    }).catch(() => {});
  }

  if (plan.applyRoleIdsInDb) {
    const { ensureStudentProfileForUser } = await import('./student.service.js');
    const { ensureCandidateProfileForUser } = await import('./employee.service.js');
    await ensureStudentProfileForUser(user.id).catch(() => {});
    await ensureCandidateProfileForUser(user.id).catch((err) => {
      logger.warn(`healPendingCandidateAfterStaleVerify: ensureCandidateProfileForUser failed: ${err?.message || err}`);
    });
  }

  logger.info(`healPendingCandidateAfterStaleVerify: repaired user ${user._id}`);
}

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
 * Logout — deletes refresh token doc. Returns user id for audit logging.
 * @param {string} refreshToken
 * @returns {Promise<string>} User id (string) who owned the refresh token
 */
const logout = async (refreshToken) => {
  const refreshTokenDoc = await Token.findOne({ token: refreshToken, type: tokenTypes.REFRESH, blacklisted: false });
  if (!refreshTokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Not found');
  }
  const userId = refreshTokenDoc.user != null ? String(refreshTokenDoc.user) : null;
  await refreshTokenDoc.deleteOne();
  if (!userId) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Not found');
  }
  return userId;
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

    const hasCandidateRole = await userHasCandidateRole(user);
    if (hasCandidateRole) {
      const { resigned } = await getResignStatusByOwnerId(user._id);
      if (resigned) {
        throw new ApiError(
          httpStatus.FORBIDDEN,
          'You have resigned and cannot sign in. Please contact an administrator for more information.',
          true,
          '',
          { errorCode: 'CANDIDATE_RESIGNED' }
        );
      }
    }

    await refreshTokenDoc.deleteOne();

    if (payload.impersonation) {
      const { impersonationId, by: adminUserId, startedAt } = payload.impersonation;
      const impersonation = await Impersonation.findById(impersonationId);
      if (!impersonation || impersonation.endedAt) throw new Error();
      return generateImpersonationTokens(user, impersonationId, adminUserId, startedAt, req);
    }
    return generateAuthTokens(user, req);
  } catch (error) {
    if (error instanceof ApiError && error.errorCode === 'CANDIDATE_RESIGNED') {
      throw error;
    }
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
  if (
    (impersonatedUser.hideFromDirectory || impersonatedUser.platformSuperUser) &&
    !adminUser.platformSuperUser
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You cannot impersonate this user');
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
 * Verify email — sets isEmailVerified; for `registrationSource: public_candidate` (non-staff),
 * also activates pending users and normalizes Candidate vs Student roleIds (atomic aggregation `$set` on `roleIds`).
 * @param {string} verifyEmailToken
 * @returns {Promise<void>}
 */
const verifyEmail = async (verifyEmailToken) => {
  try {
    const payload = jwt.verify(verifyEmailToken, config.jwt.secret);
    if (payload.type !== tokenTypes.VERIFY_EMAIL) {
      throw new jwt.JsonWebTokenError('invalid verify-email token type');
    }

    const verifyEmailTokenDoc = await Token.findOne({
      token: verifyEmailToken,
      type: tokenTypes.VERIFY_EMAIL,
      user: payload.sub,
      blacklisted: false,
    });

    const user = await getUserById(payload.sub);
    if (!user) {
      logger.warn('verifyEmail: user_not_found');
      throw new Error('user_not_found');
    }

    if (!verifyEmailTokenDoc) {
      if (user.isEmailVerified) {
        await healPendingCandidateAfterStaleVerify(user);
        logger.info('verifyEmail: idempotent_ok_already_verified');
        return;
      }
      throw new Error('Token not found');
    }

    if (verifyEmailTokenDoc.expires && verifyEmailTokenDoc.expires.getTime() < Date.now()) {
      logger.warn('verifyEmail: verify_email_token_expired_store');
      throw new Error('verify_email_store_expired');
    }

    await Token.deleteMany({ user: user.id, type: tokenTypes.VERIFY_EMAIL });

    const skipStaff = await userIsStaffForVerifyEmail(user);
    const candidateRole = await getRoleByName('Candidate');
    const studentRole = await getRoleByName('Student');

    const hasJobApplicationAsApplicant = await JobApplication.exists({ appliedBy: user._id });
    const ownedCandidateProfile = await Employee.exists({ owner: user._id });
    const noOrEmptyRoles = !user.roleIds || user.roleIds.length === 0;

    /** Public job apply (and legacy rows) may lack registrationSource; generic /public/register uses public_generic and stays admin-gated. */
    const eligibleForCandidateAutoActivate =
      user.registrationSource === 'public_candidate' ||
      (user.registrationSource !== 'public_generic' &&
        noOrEmptyRoles &&
        (!!hasJobApplicationAsApplicant || !!ownedCandidateProfile));

    const setRegistrationSourcePublicCandidate =
      eligibleForCandidateAutoActivate &&
      user.registrationSource !== 'public_candidate' &&
      user.registrationSource !== 'public_generic';

    const needsCandidateRole =
      eligibleForCandidateAutoActivate &&
      !skipStaff &&
      user.status !== 'disabled' &&
      user.status !== 'deleted';

    if (needsCandidateRole && !candidateRole) {
      logger.error('verifyEmail: Candidate role not configured');
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Server configuration error');
    }

    const plan = buildVerifyEmailUpdatePlan(
      {
        status: user.status,
        eligibleForCandidateAutoActivate,
        setRegistrationSourcePublicCandidate,
        roleIds: user.roleIds,
      },
      {
        skipStaffAutoActivate: skipStaff,
        candidateRoleId: candidateRole ? candidateRole._id : null,
        studentRoleId: studentRole ? studentRole._id : null,
      }
    );

    const pipe = buildVerifyEmailAggregationPipeline(plan);
    if (pipe) {
      await User.findByIdAndUpdate(user._id, pipe);
    } else {
      await User.findByIdAndUpdate(user._id, { $set: plan.scalarSet });
    }

    const { pendingToActive } = plan;

    if (pendingToActive && user.email) {
      const { sendCandidateAccountActivationEmail } = await import('./email.service.js');
      sendCandidateAccountActivationEmail(user.email, user.name).catch((err) => {
        logger.warn(`verifyEmail: activation email failed ${err?.message || err}`);
      });
      const cfg = (await import('../config/config.js')).default;
      const signInUrl = `${(cfg?.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '')}/authentication/sign-in/`;
      const { notify } = await import('./notification.service.js');
      notify(user.id || user._id, {
        type: 'account',
        title: 'Your account has been activated',
        message: 'You can now sign in.',
        link: signInUrl,
      }).catch(() => {});
    }

    if (plan.applyRoleIdsInDb) {
      const { ensureStudentProfileForUser } = await import('./student.service.js');
      const { ensureCandidateProfileForUser } = await import('./employee.service.js');
      await ensureStudentProfileForUser(user.id).catch(() => {});
      await ensureCandidateProfileForUser(user.id).catch((err) => {
        logger.warn(`verifyEmail: ensureCandidateProfileForUser failed: ${err?.message || err}`);
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    let reason = 'verify_email_failed';
    if (error?.name === 'TokenExpiredError') reason = 'verify_email_token_expired';
    else if (error?.name === 'JsonWebTokenError') reason = 'verify_email_token_malformed';
    else if (error?.message === 'Token not found') reason = 'verify_email_token_revoked';
    else if (error?.message === 'user_not_found') reason = 'verify_email_user_not_found';
    else if (error?.message === 'verify_email_store_expired') reason = 'verify_email_token_expired_store';
    logger.warn(`verifyEmail: ${reason} — ${error?.message || error}`);
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
  userIsStaffForVerifyEmail,
};

