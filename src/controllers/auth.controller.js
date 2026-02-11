import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/config.js';
import { createUser, updateUserById } from '../services/user.service.js';
import { generateAuthTokens, generateResetPasswordToken, generateVerifyEmailToken, getSessionsForUser } from '../services/token.service.js';
import { loginUserWithEmailAndPassword, logout as logout2, refreshAuth, resetPassword as resetPassword2, changePassword as changePassword2, verifyEmail as verifyEmail2, startImpersonation, stopImpersonation as stopImpersonationService } from '../services/auth.service.js';
import { sendResetPasswordEmail, sendVerificationEmail as sendVerificationEmail2 } from '../services/email.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { registerStudent as registerStudentService } from '../services/student.service.js';
import { registerMentor as registerMentorService } from '../services/mentor.service.js';
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

/**
 * Administrator registers a user (POST /v1/auth/register).
 * Do not issue tokens or set cookies for the new user — leave the requester (admin) logged in.
 */
const register = catchAsync(async (req, res) => {
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
  res.send({ user, tokens });
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
  await sendResetPasswordEmail(req.body.email, resetPasswordToken);
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
  await sendVerificationEmail2(req.user.email, verifyEmailToken);
  res.status(httpStatus.NO_CONTENT).send();
});

const verifyEmail = catchAsync(async (req, res) => {
  await verifyEmail2(req.query.token);
  res.status(httpStatus.NO_CONTENT).send();
});

const getMe = catchAsync(async (req, res) => {
  const sessions = await getSessionsForUser(req.user.id);
  const response = { user: req.user, sessions };
  if (req.impersonation) {
    response.impersonation = req.impersonation;
  }
  res.send(response);
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
  registerStudent,
  registerMentor,
  login,
  logout,
  refreshTokens,
  forgotPassword,
  resetPassword,
  changePassword,
  sendVerificationEmail,
  verifyEmail,
  getMe,
  impersonate,
  stopImpersonation,
};
