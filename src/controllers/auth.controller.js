import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/config.js';
import { createUser, getUserByEmail, getUserById, updateUserById } from '../services/user.service.js';
import { generateAuthTokens, generateResetPasswordToken, generateVerifyEmailToken, getSessionsForUser } from '../services/token.service.js';
import { loginUserWithEmailAndPassword, logout as logout2, refreshAuth, resetPassword as resetPassword2, changePassword as changePassword2, verifyEmail as verifyEmail2, startImpersonation, stopImpersonation as stopImpersonationService } from '../services/auth.service.js';
import { sendResetPasswordEmail, sendVerificationEmail as sendVerificationEmail2, sendCandidateInvitationEmail } from '../services/email.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { registerStudent as registerStudentService } from '../services/student.service.js';
import { registerMentor as registerMentorService } from '../services/mentor.service.js';
import {
  createCandidate,
  getCandidateByOwnerForMe,
  getResignStatusByOwnerId,
  updateUserAndCandidateForMe,
  applyInitialCandidateProfileFromAdmin,
} from '../services/employee.service.js';
import { getRoleByName } from '../services/role.service.js';
import { userHasCandidateRole, userIsAdmin, userIsAgent, validateRoleIdsForAgent } from '../utils/roleHelpers.js';
import { getMyPermissionsForFrontend } from '../services/permission.service.js';
import { pickUserDisplayForActivityLog } from '../utils/activityLogSubject.util.js';
import Impersonation from '../models/impersonation.model.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import {
  applyReferralToCandidate,
  applyOnboardInviteReferral,
  verifyReferralToken,
  logReferralEvent,
} from '../services/referralAttribution.service.js';
// import { authService, userService, tokenService, emailService } from '../services/index.js';
// import { authService, userService, tokenService, emailService } from '../services';


const ACCESS_TOKEN_COOKIE = 'accessToken';
const REFRESH_TOKEN_COOKIE = 'refreshToken';

const cookieOptions = (expires) => ({
  httpOnly: true,
  secure: config.env === 'production',
  sameSite: config.env === 'production' ? 'none' : 'lax', // 'none' required for cross-origin cookies in production
  path: '/',
  ...(expires && { expires }),
});

const setAuthCookies = (res, tokens) => {
  res.cookie(ACCESS_TOKEN_COOKIE, tokens.access.token, cookieOptions(tokens.access.expires));
  res.cookie(REFRESH_TOKEN_COOKIE, tokens.refresh.token, cookieOptions(tokens.refresh.expires));
};

/** When false (default in production), JSON bodies omit token strings; HttpOnly cookies remain. */
const includeAuthTokensInJson = () => Boolean(config.auth?.returnTokensInJson);

const withOptionalTokens = (payload, tokens) => {
  if (!includeAuthTokensInJson()) return payload;
  return { ...payload, tokens };
};

const clearAuthCookies = (res) => {
  const options = cookieOptions();
  res.clearCookie(ACCESS_TOKEN_COOKIE, options);
  res.clearCookie(REFRESH_TOKEN_COOKIE, options);
};

/** Whitelist fields for User.create — keeps profile-only fields off the User document. */
const pickCreateUserBody = (body) => {
  const keys = ['name', 'email', 'password', 'isEmailVerified', 'roleIds', 'phoneNumber', 'countryCode', 'status'];
  const out = {};
  for (const k of keys) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
};

/** Enrich user object with fresh profile picture URL (S3 presigned URLs expire after ~1h). */
const enrichUserWithFreshProfilePictureUrl = async (user) => {
  const userObj = user.toJSON ? user.toJSON() : { ...user };
  if (userObj.profilePicture?.key) {
    try {
      const freshUrl = await generatePresignedDownloadUrl(userObj.profilePicture.key, 7 * 24 * 3600);
      userObj.profilePicture = { ...userObj.profilePicture, url: freshUrl };
    } catch (err) {
      /* keep existing url if regeneration fails */
    }
  }
  return userObj;
};

/**
 * Register (POST /v1/auth/register).
 * - Candidate from invite (role=user, adminId): create User (pending) + Employee. No tokens until admin activates.
 * - Admin registration (req.user present): create user, no tokens, activity log.
 */
const register = catchAsync(async (req, res) => {
  const { adminId, phoneNumber, countryCode } = req.body;

  if (adminId) {
    const user = await createUser({
      ...req.body,
      adminId,
      status: 'pending',
      phoneNumber: phoneNumber || undefined,
      countryCode: countryCode || undefined,
    });
    const completionPercentage = 30;
    const candidate = await createCandidate(user._id, {
      fullName: user.name,
      email: user.email,
      phoneNumber: (phoneNumber && String(phoneNumber).trim()) || '0000000000',
      ...(countryCode && String(countryCode).trim() && { countryCode: String(countryCode).trim().toUpperCase() }),
      adminId,
      isProfileCompleted: completionPercentage,
    });
    const inviterRef = await applyOnboardInviteReferral(candidate._id, user.email, adminId);
    if (inviterRef.applied) {
      try {
        await activityLogService.createActivityLog(
          adminId,
          ActivityActions.REFERRAL_CLAIM,
          EntityTypes.CANDIDATE,
          candidate._id,
          { source: 'invite_onboard', claimStage: 'onboard_invite' },
          req
        );
      } catch (e) {
        logReferralEvent('referral_activity_log_failed', { message: e?.message });
      }
    } else {
      logReferralEvent('referral_invite_attribution_skipped', {
        reason: inviterRef.reason,
        candidateId: String(candidate._id),
      });
    }
    const verifyEmailToken = await generateVerifyEmailToken(user);
    await sendVerificationEmail2(user.email, verifyEmailToken, {
      req,
      recipientName: user.name || 'there',
      accountContext: 'new candidate account',
    });
    res.status(httpStatus.CREATED).send({
      user,
      message: 'Registration successful. Your account is pending administrator approval. You will be able to sign in once activated.',
    });
    return;
  }

  if (req.user && Array.isArray(req.body.roleIds) && req.body.roleIds.length > 0) {
    const isAdmin = await userIsAdmin(req.user);
    const isAgent = await userIsAgent(req.user);
    if (isAgent && !isAdmin) {
      const validation = await validateRoleIdsForAgent(req.body.roleIds);
      if (!validation.allowed) {
        throw new ApiError(
          httpStatus.FORBIDDEN,
          `Agents cannot assign the following roles: ${validation.restrictedNames.join(', ')}. Only Employee, Student, and Mentor are allowed.`
        );
      }
    }
  }

  const { employeeId, shortBio, joiningDate, department, designation, degree, salaryRange } = req.body;
  const bodyForCreate = pickCreateUserBody(req.body);
  if (!req.user) {
    delete bodyForCreate.status;
  } else {
    const isAdmin = await userIsAdmin(req.user);
    if (!isAdmin && bodyForCreate.status !== undefined) {
      delete bodyForCreate.status;
    }
  }
  const user = await createUser(bodyForCreate);
  if (req.user) {
    await activityLogService.createActivityLog(
      req.user.id,
      ActivityActions.USER_CREATE,
      EntityTypes.USER,
      user.id,
      { roleIds: user.roleIds, ...pickUserDisplayForActivityLog(user) },
      req
    );
    try {
      await applyInitialCandidateProfileFromAdmin(user.id, {
        employeeId,
        shortBio,
        joiningDate,
        department,
        designation,
        degree,
        salaryRange,
      });
    } catch (e) {
      if (e && (e.code === 11000 || String(e.message || '').includes('duplicate'))) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Employee ID is already in use. Choose a different value or leave it blank to auto-assign.');
      }
      throw e;
    }
  }
  res.status(httpStatus.CREATED).send({ user });
});

/**
 * Public registration: no auth required. User is created with status 'pending'.
 * They cannot login or access the system until an administrator sets status to 'active'.
 * No tokens or cookies are issued.
 */
const publicRegister = catchAsync(async (req, res) => {
  const body = { ...req.body, status: 'pending' };
  delete body.roleIds;
  delete body.isEmailVerified;
  delete body.platformSuperUser;
  delete body.hideFromDirectory;
  const user = await createUser(body);
  res.status(httpStatus.CREATED).send({
    user,
    message: 'Registration successful. Your account is pending administrator approval. You will be able to sign in once activated.',
  });
});

/**
 * Public candidate onboarding: no auth required.
 * Creates User (status 'pending') and a Candidate linked to that user so they appear in the ATS candidate list.
 * Assigns Student role by default. If the email is already registered, creates only the missing Candidate and ensures Student role.
 */
const publicRegisterCandidate = catchAsync(async (req, res) => {
  const studentRole = await getRoleByName('Student');
  if (!studentRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Student role not found. Please contact administrator.');
  }

  const { name, email, password, phoneNumber, countryCode, ref: referralRef } = req.body;
  const phone = (phoneNumber && String(phoneNumber).trim()) || '0000000000';
  const cc = countryCode && String(countryCode).trim().toUpperCase();
  let user;
  try {
    user = await createUser({
      name,
      email,
      password,
      status: 'pending',
      roleIds: [studentRole._id],
      ...(phone && phone !== '0000000000' && { phoneNumber: phone }),
      ...(cc && { countryCode: cc }),
    });
  } catch (err) {
    if (err.statusCode !== httpStatus.BAD_REQUEST || err.message !== 'Email already taken') throw err;
    user = await getUserByEmail(email);
    if (!user) throw err;
    // Ensure existing user has Student role
    const existingRoleIds = (user.roleIds || []).map((id) => id.toString());
    if (!existingRoleIds.includes(studentRole._id.toString())) {
      await updateUserById(user._id, { roleIds: [...(user.roleIds || []), studentRole._id] });
      user.roleIds = [...(user.roleIds || []), studentRole._id];
    }
  }
  let candidate;
  try {
    candidate = await createCandidate(user._id, {
      fullName: name,
      email,
      phoneNumber: phone,
      ...(cc && { countryCode: cc }),
      adminId: user._id,
    });
  } catch (err) {
    if (err.statusCode === httpStatus.CONFLICT && err.message?.includes('already exists')) {
      return res.status(httpStatus.OK).send({
        user,
        message: 'You are already registered and in the employee list. You can sign in when your account is active.',
      });
    }
    throw err;
  }
  if (referralRef && String(referralRef).trim() && candidate?._id) {
    const v = verifyReferralToken(String(referralRef).trim());
    if (v.ok) {
      const r = await applyReferralToCandidate(candidate._id, email, v.data);
      if (r.applied) {
        try {
          await activityLogService.createActivityLog(
            v.data.t,
            ActivityActions.REFERRAL_CLAIM,
            EntityTypes.CANDIDATE,
            candidate._id,
            { jti: v.data.jti, source: v.data.s, org: v.data.o, claimStage: 'public_register' },
            req
          );
        } catch (e) {
          logReferralEvent('referral_activity_log_failed', { message: e?.message });
        }
      } else {
        logReferralEvent('referral_claim_skipped', { reason: r.reason, candidateId: String(candidate._id) });
      }
    } else {
      logReferralEvent('referral_token_invalid', { error: v.error });
    }
  }
  res.status(httpStatus.CREATED).send({
    user,
    candidate,
    message: user.status === 'pending'
      ? 'Registration successful. Your account is pending administrator approval. You will be able to sign in once activated.'
      : 'You were already registered. You have been added to the employee list.',
  });
});

/**
 * Register a recruiter (Admin only)
 * Creates User with Recruiter role
 */
const registerRecruiter = catchAsync(async (req, res) => {
  const recruiterRole = await getRoleByName('Recruiter');
  if (!recruiterRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Recruiter role not found. Please contact administrator.');
  }
  const userData = {
    ...req.body,
    isEmailVerified: true,
    status: 'active',
    roleIds: [recruiterRole._id],
    phoneNumber: req.body.phoneNumber || undefined,
    countryCode: req.body.countryCode || undefined,
  };
  const user = await createUser(userData);
  if (req.user) {
    await activityLogService.createActivityLog(
      req.user.id,
      ActivityActions.USER_CREATE,
      EntityTypes.USER,
      user.id,
      { role: 'Recruiter', ...pickUserDisplayForActivityLog(user) },
      req
    );
  }
  res.status(httpStatus.CREATED).send({ user });
});

/**
 * Register a student
 * Creates both User and Student profile records
 * - If admin registers: status='active', isEmailVerified=true, no tokens issued
 * - If student self-registers: status='active', isEmailVerified=false, tokens issued
 */
const registerStudent = catchAsync(async (req, res) => {
  const isAdminRegistration = !!req.user; // If req.user exists, it's an admin registration
  
  const { user, student } = await registerStudentService(req.body, isAdminRegistration);
  
  // Log activity if admin registered the student
  if (isAdminRegistration) {
    await activityLogService.createActivityLog(
      req.user.id,
      ActivityActions.USER_CREATE,
      EntityTypes.USER,
      user.id,
      { role: 'Student', studentProfile: true, ...pickUserDisplayForActivityLog(user) },
      req
    );
  }
  
  // If student self-registers, issue tokens and set cookies
  if (!isAdminRegistration) {
    const tokens = await generateAuthTokens(user, req);
    setAuthCookies(res, tokens);
    res.status(httpStatus.CREATED).send(withOptionalTokens({ user, student }, tokens));
  } else {
    // Admin registration: no tokens, just return user and student
    res.status(httpStatus.CREATED).send({ user, student });
  }
});

/**
 * Register a mentor
 * Creates both User and Mentor profile records
 * - If admin registers: status='active', isEmailVerified=true, no tokens issued
 * - If mentor self-registers: status='active', isEmailVerified=false, tokens issued
 */
const registerMentor = catchAsync(async (req, res) => {
  const isAdminRegistration = !!req.user; // If req.user exists, it's an admin registration
  
  const { user, mentor } = await registerMentorService(req.body, isAdminRegistration);
  
  // Log activity if admin registered the mentor
  if (isAdminRegistration) {
    await activityLogService.createActivityLog(
      req.user.id,
      ActivityActions.USER_CREATE,
      EntityTypes.USER,
      user.id,
      { role: 'Mentor', mentorProfile: true, ...pickUserDisplayForActivityLog(user) },
      req
    );
  }
  
  // If mentor self-registers, issue tokens and set cookies
  if (!isAdminRegistration) {
    const tokens = await generateAuthTokens(user, req);
    setAuthCookies(res, tokens);
    res.status(httpStatus.CREATED).send(withOptionalTokens({ user, mentor }, tokens));
  } else {
    // Admin registration: no tokens, just return user and mentor
    res.status(httpStatus.CREATED).send({ user, mentor });
  }
});

const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const user = await loginUserWithEmailAndPassword(email, password);
  const hasCandidateRole = await userHasCandidateRole(user);
  if (hasCandidateRole) {
    const { resigned } = await getResignStatusByOwnerId(user._id);
    if (resigned) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'You have resigned and cannot sign in. Please contact an administrator for more information.',
        true,
        '',
        { errorCode: 'CANDIDATE_RESIGNED' }
      );
    }
  }
  await updateUserById(user.id, { lastLoginAt: new Date() });
  user.lastLoginAt = new Date();
  const tokens = await generateAuthTokens(user, req);
  setAuthCookies(res, tokens);
  await activityLogService.createActivityLog(
    user.id,
    ActivityActions.USER_LOGIN,
    EntityTypes.USER,
    String(user.id),
    { signInMethod: 'password', ...pickUserDisplayForActivityLog(user) },
    req
  );
  const userObj = await enrichUserWithFreshProfilePictureUrl(user);
  res.send(withOptionalTokens({ user: userObj }, tokens));
});

const logout = catchAsync(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE] || req.body?.refreshToken;
  if (!refreshToken) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }
  const userId = await logout2(refreshToken);
  const userForMeta = await getUserById(userId);
  await activityLogService.createActivityLog(
    userId,
    ActivityActions.USER_LOGOUT,
    EntityTypes.USER,
    userId,
    { signOutMethod: 'refresh_token', ...pickUserDisplayForActivityLog(userForMeta) },
    req
  );
  clearAuthCookies(res);
  res.status(httpStatus.NO_CONTENT).send();
});

const refreshTokens = catchAsync(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE] || req.body?.refreshToken;
  if (!refreshToken) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }
  const tokens = await refreshAuth(refreshToken, req);
  setAuthCookies(res, tokens);
  if (includeAuthTokensInJson()) {
    res.send({ ...tokens });
  } else {
    res.status(httpStatus.NO_CONTENT).send();
  }
});

const forgotPassword = catchAsync(async (req, res) => {
  const resetPasswordToken = await generateResetPasswordToken(req.body.email);
  const user = await getUserByEmail(req.body.email);
  await sendResetPasswordEmail(req.body.email, resetPasswordToken, {
    req,
    recipientName: user?.name || 'there',
  });
  res.status(httpStatus.NO_CONTENT).send();
});

const resetPassword = catchAsync(async (req, res) => {
  await resetPassword2(req.query.token, req.body.password);
  res.status(httpStatus.NO_CONTENT).send();
});

const changePassword = catchAsync(async (req, res) => {
  await changePassword2(req.user.id, req.body.currentPassword, req.body.newPassword);
  res.status(httpStatus.NO_CONTENT).send();
});

const sendVerificationEmail = catchAsync(async (req, res) => {
  const verifyEmailToken = await generateVerifyEmailToken(req.user);
  await sendVerificationEmail2(req.user.email, verifyEmailToken, {
    req,
    recipientName: req.user.name || 'there',
    accountContext: 'signed-in user',
  });
  res.status(httpStatus.NO_CONTENT).send();
});

/** Send verification email to the currently logged-in user (self-service). No permission required. */
const sendMyVerificationEmail = catchAsync(async (req, res) => {
  const verifyEmailToken = await generateVerifyEmailToken(req.user);
  await sendVerificationEmail2(req.user.email, verifyEmailToken, {
    req,
    recipientName: req.user.name || 'there',
    accountContext: 'signed-in user',
  });
  res.status(httpStatus.NO_CONTENT).send();
});

const verifyEmail = catchAsync(async (req, res) => {
  await verifyEmail2(req.query.token);
  res.status(httpStatus.NO_CONTENT).send();
});

const sendCandidateInvitation = catchAsync(async (req, res) => {
  const { email, onboardUrl, invitations } = req.body;
  const actorId = String(req.user.id || req.user._id);
  const onboardingEntityId = 'onboarding-invite';

  if (invitations && Array.isArray(invitations)) {
    const results = { successful: [], failed: [], total: invitations.length };
    const { notifyByEmail } = await import('../services/notification.service.js');
    const emailPromises = invitations.map(async (invitation) => {
      try {
        await sendCandidateInvitationEmail(invitation.email, invitation.onboardUrl, {
          inviterName: req.user.name || 'Dharwin team',
          organisationName: 'Dharwin Business Solutions',
          expiresIn: '24 hours',
        });
        notifyByEmail(invitation.email, {
          type: 'general',
          title: "You're invited to complete your onboarding",
          message: 'Click the link in the email to get started.',
          link: invitation.onboardUrl,
        }).catch(() => {});
        results.successful.push({ email: invitation.email, onboardUrl: invitation.onboardUrl });
      } catch (error) {
        results.failed.push({ email: invitation.email, onboardUrl: invitation.onboardUrl, error: error.message });
      }
    });
    await Promise.allSettled(emailPromises);
    if (results.successful.length > 0) {
      await activityLogService.createActivityLog(
        actorId,
        ActivityActions.CANDIDATE_ONBOARDING_SHARE,
        EntityTypes.CANDIDATE,
        onboardingEntityId,
        {
          deliveryMethod: 'email',
          inviteMode: invitations.length > 1 ? 'bulk' : 'single',
          invitationCount: invitations.length,
          successfulCount: results.successful.length,
          failedCount: results.failed.length,
          recipients: results.successful.map((entry) => entry.email),
        },
        req
      );
    }
    res.status(httpStatus.OK).json({
      message: `Bulk invitation completed. ${results.successful.length} successful, ${results.failed.length} failed.`,
      results,
    });
  } else {
    await sendCandidateInvitationEmail(email, onboardUrl, {
      inviterName: req.user.name || 'Dharwin team',
      organisationName: 'Dharwin Business Solutions',
      expiresIn: '24 hours',
    });
    await activityLogService.createActivityLog(
      actorId,
      ActivityActions.CANDIDATE_ONBOARDING_SHARE,
      EntityTypes.CANDIDATE,
      onboardingEntityId,
      {
        deliveryMethod: 'email',
        inviteMode: 'single',
        invitationCount: 1,
        successfulCount: 1,
        failedCount: 0,
        recipient: email,
      },
      req
    );
    const { notifyByEmail } = await import('../services/notification.service.js');
    notifyByEmail(email, {
      type: 'general',
      title: "You're invited to complete your onboarding",
      message: 'Click the link in the email to get started.',
      link: onboardUrl,
    }).catch(() => {});
    res.status(httpStatus.OK).json({ message: 'Onboarding invitation email sent successfully', email });
  }
});

const getMe = catchAsync(async (req, res) => {
  const hasCandidateRole = await userHasCandidateRole(req.user);
  if (hasCandidateRole) {
    const { resigned } = await getResignStatusByOwnerId(req.user._id);
    if (resigned) {
      return res.status(httpStatus.FORBIDDEN).json({
        message: 'You have resigned and cannot use this account. Please contact an administrator for more information.',
        code: 'CANDIDATE_RESIGNED',
      });
    }
  }
  const sessions = await getSessionsForUser(req.user.id);
  const userObj = await enrichUserWithFreshProfilePictureUrl(req.user);
  const response = { user: userObj, sessions };
  if (req.impersonation) {
    response.impersonation = req.impersonation;
  }
  res.send(response);
});

/**
 * GET /auth/me/with-candidate
 * Returns User + Candidate merged when user has Candidate role. Single source for Personal Information and My Profile.
 */
const getMeWithCandidate = catchAsync(async (req, res) => {
  const sessions = await getSessionsForUser(req.user.id);
  const userObj = await enrichUserWithFreshProfilePictureUrl(req.user);
  const response = { user: userObj, candidate: null, sessions };
  if (req.impersonation) {
    response.impersonation = req.impersonation;
  }
  const hasCandidateRole = await userHasCandidateRole(req.user);
  if (!hasCandidateRole) {
    return res.send(response);
  }
  const candidate = await getCandidateByOwnerForMe(req.user._id);
  if (candidate) {
    const rd = candidate.resignDate ? new Date(candidate.resignDate) : null;
    if (rd) {
      rd.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (rd <= today) {
        return res.status(httpStatus.FORBIDDEN).json({
          message: 'You have resigned and cannot use this account. Please contact an administrator for more information.',
          code: 'CANDIDATE_RESIGNED',
        });
      }
    }
    response.candidate = candidate.toJSON ? candidate.toJSON() : { ...candidate };
  }
  res.send(response);
});

/**
 * PATCH /auth/me/with-candidate
 * Atomically updates both User and Candidate in one transaction.
 */
const updateMeWithCandidate = catchAsync(async (req, res) => {
  const { user, candidate } = await updateUserAndCandidateForMe(req.user.id, req.body);
  const userObj = await enrichUserWithFreshProfilePictureUrl(user);
  const candidateObj = candidate ? (candidate.toJSON ? candidate.toJSON() : { ...candidate }) : null;
  if (candidateObj?.profilePicture?.key) {
    try {
      const freshUrl = await generatePresignedDownloadUrl(candidateObj.profilePicture.key, 7 * 24 * 3600);
      candidateObj.profilePicture = { ...candidateObj.profilePicture, url: freshUrl };
    } catch (_) {
      /* ignore presigned URL errors */
    }
  }
  res.send({ user: userObj, candidate: candidateObj });
});

/**
 * Update own profile (PATCH /auth/me).
 * Allows any authenticated user to update name, notificationPreferences, profilePicture.
 * Email cannot be changed via this route; only admins can change email via PATCH /users/:userId.
 */
const updateMe = catchAsync(async (req, res) => {
  const allowedFields = [
    'name',
    'notificationPreferences',
    'profilePicture',
    'phoneNumber',
    'countryCode',
    'education',
    'domain',
    'location',
    'profileSummary',
  ];
  const payload = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      payload[key] = req.body[key];
    }
  }
  if (Object.keys(payload).length === 0) {
    const userObj = await enrichUserWithFreshProfilePictureUrl(req.user);
    return res.send(userObj);
  }
  const user = await updateUserById(req.user.id, payload);
  const userObj = await enrichUserWithFreshProfilePictureUrl(user);
  res.send(userObj);
});

const getMyPermissions = catchAsync(async (req, res) => {
  const ctx = await getMyPermissionsForFrontend(req.user);
  res.send(ctx);
});

/**
 * Start impersonation: admin temporarily acts as target user.
 * Requires Administrator role (by roleIds). Sets cookies to impersonated user's session.
 */
const impersonate = catchAsync(async (req, res) => {
  const adminRefreshToken = req.cookies[REFRESH_TOKEN_COOKIE] || req.body?.refreshToken;
  if (!adminRefreshToken) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Refresh token required to start impersonation');
  }
  const result = await startImpersonation(req.user, req.body.userId, adminRefreshToken);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.IMPERSONATION_START,
    EntityTypes.IMPERSONATION,
    result.impersonation.impersonationId,
    { impersonatedUserId: result.user.id, ...pickUserDisplayForActivityLog(result.user) },
    req
  );
  setAuthCookies(res, result.tokens);
  res.status(httpStatus.OK).send(
    withOptionalTokens(
      {
        user: result.user,
        impersonation: result.impersonation,
      },
      result.tokens
    )
  );
});

/**
 * Stop impersonation: restore admin session. Requires current request to be in impersonation mode.
 */
const stopImpersonation = catchAsync(async (req, res) => {
  if (!req.impersonation) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Not in impersonation mode');
  }
  const currentRefreshToken = req.cookies[REFRESH_TOKEN_COOKIE] || req.body?.refreshToken;
  if (!currentRefreshToken) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Refresh token required to stop impersonation');
  }
  const impRow = await Impersonation.findById(req.impersonation.impersonationId).lean();
  const impersonationTarget = impRow?.impersonatedUser ? await getUserById(impRow.impersonatedUser) : null;
  const result = await stopImpersonationService(req.impersonation.impersonationId, currentRefreshToken);
  await activityLogService.createActivityLog(
    req.impersonation.by,
    ActivityActions.IMPERSONATION_END,
    EntityTypes.IMPERSONATION,
    req.impersonation.impersonationId,
    pickUserDisplayForActivityLog(impersonationTarget),
    req
  );
  setAuthCookies(res, result.tokens);
  res.send(withOptionalTokens({ user: result.user }, result.tokens));
});

export {
  register,
  publicRegister,
  publicRegisterCandidate,
  registerStudent,
  registerRecruiter,
  registerMentor,
  login,
  logout,
  refreshTokens,
  forgotPassword,
  resetPassword,
  changePassword,
  sendVerificationEmail,
  sendMyVerificationEmail,
  verifyEmail,
  sendCandidateInvitation,
  getMe,
  updateMe,
  getMeWithCandidate,
  updateMeWithCandidate,
  getMyPermissions,
  impersonate,
  stopImpersonation,
};
