import passport from 'passport';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

/**
 * Document download authentication middleware.
 * Supports: 1) Cookie (accessToken), 2) Bearer header, 3) Query param ?token= for direct browser access.
 */
const documentAuth = async (req, res, next) => {
  return new Promise((resolve, reject) => {
    function tryWithReq(request) {
      passport.authenticate('jwt', { session: false }, (err, user, _info) => {
        if (user) {
          req.user = user;
          return resolve();
        }
        tryQueryToken();
      })(request, res, next);
    }

    function tryQueryToken() {
      const token = req.query.token;
      if (!token) {
        return reject(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
      }
      const fakeReq = {
        ...req,
        headers: {
          ...req.headers,
          authorization: `Bearer ${token}`,
        },
      };
      passport.authenticate('jwt', { session: false }, (err, user, info) => {
        if (err || info || !user) {
          return reject(new ApiError(httpStatus.UNAUTHORIZED, 'Invalid or expired token'));
        }
        req.user = user;
        resolve();
      })(fakeReq, res, next);
    }

    // Try passport with original req first (covers Bearer header and accessToken cookie)
    tryWithReq(req);
  })
    .then(() => next())
    .catch((err) => next(err));
};

export default documentAuth;
