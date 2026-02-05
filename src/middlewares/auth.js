import passport from 'passport';
import jwt from 'jsonwebtoken';
import { ExtractJwt } from 'passport-jwt';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { roleRights } from '../config/roles.js';

const ACCESS_TOKEN_COOKIE = 'accessToken';

const getAccessTokenFromRequest = (req) => {
  if (req.cookies?.[ACCESS_TOKEN_COOKIE]) return req.cookies[ACCESS_TOKEN_COOKIE];
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
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

  if (requiredRights.length) {
    const userRights = roleRights.get(user.role);
    const hasRequiredRights = requiredRights.every((requiredRight) => userRights.includes(requiredRight));
    if (!hasRequiredRights && req.params.userId !== user.id) {
      return reject(new ApiError(httpStatus.FORBIDDEN, 'Forbidden'));
    }
  }

  resolve();
};

const auth = (...requiredRights) => async (req, res, next) => {
  return new Promise((resolve, reject) => {
    passport.authenticate('jwt', { session: false }, verifyCallback(req, resolve, reject, requiredRights))(req, res, next);
  })
    .then(() => next())
    .catch((err) => next(err));
};

export default auth;

