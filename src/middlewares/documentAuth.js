import passport from 'passport';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

/**
 * Document download authentication middleware.
 * Supports Bearer token (header) or query param ?token= for direct browser access.
 */
const documentAuth = async (req, res, next) => {
  return new Promise((resolve, reject) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      passport.authenticate('jwt', { session: false }, (err, user, info) => {
        if (user) {
          req.user = user;
          return resolve();
        }
        tryQueryToken();
      })(req, res, next);
    } else {
      tryQueryToken();
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
  })
    .then(() => next())
    .catch((err) => next(err));
};

export default documentAuth;
