import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/config.js';
import { createUser, getUserByEmail, updateUserById } from '../services/user.service.js';
import { generateAuthTokens, generateResetPasswordToken, generateVerifyEmailToken, getSessionsForUser } from '../services/token.service.js';
import { loginUserWithEmailAndPassword, logout as logout2, refreshAuth, resetPassword as resetPassword2, changePassword as changePassword2, verifyEmail as verifyEmail2, startImpersonation, stopImpersonation as stopImpersonationService } from '../services/auth.service.js';
import { sendResetPasswordEmail, sendVerificationEmail as sendVerificationEmail2, sendCandidateInvitationEmail } from '../services/email.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { registerStudent as registerStudentService } from '../services/student.service.js';
import { registerMentor as registerMentorService } from '../services/mentor.service.js';
import { createCandidate } from '../services/candidate.service.js';
import { getRoleByName } from '../services/role.service.js';
import { getMyPermissionsForFrontend } from '../services/permission.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
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

const clearAuthCookies = (res) => {
  const options = cookieOptions();
  res.clearCookie(ACCESS_TOKEN_COOKIE, options);
  res.clearCookie(REFRESH_TOKEN_COOKIE, options);
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
 * - Candidate from invite (role=user, adminId): create User (pending) + Candidate. No tokens until admin activates.
 * - Admin registration (req.user present): create user, no tokens, activity log.
 */
const register = catchAsync(async (req, res) => {
  const { role, adminId, phoneNumber, countryCode } = req.body;

  if (role === 'user' && adminId) {
    const user = await createUser({
      ...req.body,
      role: 'user',
      adminId,
      status: 'pending',
      phoneNumber: phoneNumber || undefined,
      countryCode: countryCode || undefined,
    });
    const completionPercentage = 30;
    await createCandidate(user._id, {
      fullName: user.name,
      email: user.email,
      phoneNumber: (phoneNumber && String(phoneNumber).trim()) || '0000000000',
      adminId,
      isProfileCompleted: completionPercentage,
    });
    const verifyEmailToken = await generateVerifyEmailToken(user);
    await sendVerificationEmail2(user.email, verifyEmailToken, { req });
    res.status(httpStatus.CREATED).send({
      user,
      message: 'Registration successful. Your account is pending administrator approval. You will be able to sign in once activated.',
    });
    return;
  }

  const user = await createUser(req.body);
  if (req.user) {
    await activityLogService.createActivityLog(req.user.id, ActivityActions.USER_CREATE, EntityTypes.USER, user.id, { role: user.role }, req);
  }
  res.status(httpStatus.CREATED).send({ user });
});

/**
 * Public registration: no auth required. User is created with status 'pending'.
 * They cannot login or access the system until an administrator sets status to 'active'.
 * No tokens or cookies are issued.
 */
const publicRegister = catchAsync(async (req, res) => {
  const user = await createUser({ ...req.body, status: 'pending' });
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

  const { name, email, password, phoneNumber } = req.body;
  const phone = (phoneNumber && String(phoneNumber).trim()) || '0000000000';
  let user;
  try {
    user = await createUser({
      name,
      email,
      password,
      status: 'pending',
      roleIds: [studentRole._id],
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
      adminId: user._id,
    });
  } catch (err) {
    if (err.statusCode === httpStatus.CONFLICT && err.message?.includes('already exists')) {
      return res.status(httpStatus.OK).send({
        user,
        message: 'You are already registered and in the candidate list. You can sign in when your account is active.',
      });
    }
    throw err;
  }
  res.status(httpStatus.CREATED).send({
    user,
    candidate,
    message: user.status === 'pending'
      ? 'Registration successful. Your account is pending administrator approval. You will be able to sign in once activated.'
      : 'You were already registered. You have been added to the candidate list.',
  });
});

/**
 * Register a recruiter (Admin only)
 * Creates User with Recruiter role
 */
const registerRecruiter = catchAsync(async (req, res) => {
  const recruiterRole = await getRoleByName('Recruiter');
  const userData = {
    ...req.body,
    role: 'recruiter',
    isEmailVerified: true,
    status: 'active',
    roleIds: recruiterRole ? [recruiterRole._id] : [],
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
      { role: 'Recruiter' },
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
      { role: 'Student', studentProfile: true },
      req
    );
  }
  
  // If student self-registers, issue tokens and set cookies
  if (!isAdminRegistration) {
    const tokens = await generateAuthTokens(user, req);
    setAuthCookies(res, tokens);
    res.status(httpStatus.CREATED).send({ user, student, tokens });
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
      { role: 'Mentor', mentorProfile: true },
      req
    );
  }
  
  // If mentor self-registers, issue tokens and set cookies
  if (!isAdminRegistration) {
    const tokens = await generateAuthTokens(user, req);
    setAuthCookies(res, tokens);
    res.status(httpStatus.CREATED).send({ user, mentor, tokens });
  } else {
    // Admin registration: no tokens, just return user and mentor
    res.status(httpStatus.CREATED).send({ user, mentor });
  }
});

const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const user = await loginUserWithEmailAndPassword(email, password);
  await updateUserById(user.id, { lastLoginAt: new Date() });
  user.lastLoginAt = new Date();
  const tokens = await generateAuthTokens(user, req);
  setAuthCookies(res, tokens);
  const userObj = await enrichUserWithFreshProfilePictureUrl(user);
  res.send({ user: userObj, tokens });
});

const logout = catchAsync(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE] || req.body?.refreshToken;
  if (!refreshToken) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }
  await logout2(refreshToken);
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
  res.send({ ...tokens });
});

const forgotPassword = catchAsync(async (req, res) => {
  const resetPasswordToken = await generateResetPasswordToken(req.body.email);
  await sendResetPasswordEmail(req.body.email, resetPasswordToken, { req });
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
  await sendVerificationEmail2(req.user.email, verifyEmailToken, { req });
  res.status(httpStatus.NO_CONTENT).send();
});

const verifyEmail = catchAsync(async (req, res) => {
  await verifyEmail2(req.query.token);
  res.status(httpStatus.NO_CONTENT).send();
});

const sendCandidateInvitation = catchAsync(async (req, res) => {
  const { email, onboardUrl, invitations } = req.body;

  if (invitations && Array.isArray(invitations)) {
    const results = { successful: [], failed: [], total: invitations.length };
    const { notifyByEmail } = await import('../services/notification.service.js');
    const emailPromises = invitations.map(async (invitation) => {
      try {
        await sendCandidateInvitationEmail(invitation.email, invitation.onboardUrl);
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
    res.status(httpStatus.OK).json({
      message: `Bulk invitation completed. ${results.successful.length} successful, ${results.failed.length} failed.`,
      results,
    });
  } else {
    await sendCandidateInvitationEmail(email, onboardUrl);
    const { notifyByEmail } = await import('../services/notification.service.js');
    notifyByEmail(email, {
      type: 'general',
      title: "You're invited to complete your onboarding",
      message: 'Click the link in the email to get started.',
      link: onboardUrl,
    }).catch(() => {});
    res.status(httpStatus.OK).json({ message: 'Candidate invitation email sent successfully', email });
  }
});

const getMe = catchAsync(async (req, res) => {
  const sessions = await getSessionsForUser(req.user.id);
  const userObj = await enrichUserWithFreshProfilePictureUrl(req.user);
  const response = { user: userObj, sessions };
  if (req.impersonation) {
    response.impersonation = req.impersonation;
  }
  res.send(response);
});

/**
 * Update own profile (PATCH /auth/me).
 * Allows any authenticated user to update name, notificationPreferences, profilePicture.
 * Email cannot be changed via this route; only admins can change email via PATCH /users/:userId.
 */
const updateMe = catchAsync(async (req, res) => {
  const allowedFields = ['name', 'notificationPreferences', 'profilePicture'];
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
    { impersonatedUserId: result.user.id },
    req
  );
  setAuthCookies(res, result.tokens);
  res.status(httpStatus.OK).send({
    user: result.user,
    tokens: result.tokens,
    impersonation: result.impersonation,
  });
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
  const result = await stopImpersonationService(req.impersonation.impersonationId, currentRefreshToken);
  await activityLogService.createActivityLog(
    req.impersonation.by,
    ActivityActions.IMPERSONATION_END,
    EntityTypes.IMPERSONATION,
    req.impersonation.impersonationId,
    {},
    req
  );
  setAuthCookies(res, result.tokens);
  res.send({ user: result.user, tokens: result.tokens });
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
  verifyEmail,
  sendCandidateInvitation,
  getMe,
  updateMe,
  getMyPermissions,
  impersonate,
  stopImpersonation,
};
