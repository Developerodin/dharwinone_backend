import passport from 'passport';
import jwt from 'jsonwebtoken';
import { ExtractJwt } from 'passport-jwt';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getUserPermissionContext } from '../services/permission.service.js';

const ACCESS_TOKEN_COOKIE = 'accessToken';

const getAccessTokenFromRequest = (req) => {
  // Prefer Authorization: Bearer header for explicit tokens (e.g. Postman),
  // then fall back to cookie for browser flows.
  const headerToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (headerToken) return headerToken;
  return req.cookies?.[ACCESS_TOKEN_COOKIE] || null;
};

const verifyCallback = (req, resolve, reject, requiredRights) => async (err, user, info) => {
  if (err || info || !user) {
    return reject(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }
  req.user = user;

  const token = getAccessTokenFromRequest(req);
  if (token) {
    try {
      const payload = jwt.decode(token);
      if (payload?.impersonation) req.impersonation = payload.impersonation;
    } catch (e) {
      // ignore decode errors
    }
  }

  // Compute permission context for this request (roleIds → permissions).
  // This is used by downstream permission middleware.
  try {
    req.authContext = await getUserPermissionContext(user);
  } catch (e) {
    return reject(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to load permissions'));
  }

  resolve();
};

// requiredRights parameter is kept for backward compatibility but is no-op now.
const auth = (...requiredRights) => async (req, res, next) => {
  return new Promise((resolve, reject) => {
    passport.authenticate('jwt', { session: false }, verifyCallback(req, resolve, reject, requiredRights))(req, res, next);
  })
    .then(() => next())
    .catch((err) => next(err));
};

export default auth;

