import passport from 'passport';
import jwt from 'jsonwebtoken';
import { ExtractJwt } from 'passport-jwt';
import { getUserPermissionContext } from '../services/permission.service.js';

const ACCESS_TOKEN_COOKIE = 'accessToken';

const getAccessTokenFromRequest = (req) => {
  // Prefer Authorization: Bearer header for explicit tokens (e.g. Postman),
  // then fall back to cookie for browser flows.
  const headerToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (headerToken) return headerToken;
  return req.cookies?.[ACCESS_TOKEN_COOKIE] || null;
};

const verifyCallback = (req, resolve, reject) => async (err, user, info) => {
  // Optional auth: if no user or error, just continue without setting req.user
  if (err || info || !user) {
    return resolve(); // Continue without authentication
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
    // If we can't load permissions, just continue without auth context
    return resolve();
  }

  resolve();
};

/**
 * Optional authentication middleware.
 * If a valid token is provided, sets req.user and req.authContext.
 * If no token or invalid token, continues without setting req.user (no error).
 */
const optionalAuth = () => async (req, res, next) => {
  return new Promise((resolve, reject) => {
    passport.authenticate('jwt', { session: false }, verifyCallback(req, resolve, reject))(req, res, next);
  })
    .then(() => next())
    .catch((err) => next(err));
};

export default optionalAuth;
