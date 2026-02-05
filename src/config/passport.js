import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import config from './config.js';
import { tokenTypes } from './tokens.js';
import User from '../models/user.model.js';

const ACCESS_TOKEN_COOKIE = 'accessToken';

const jwtFromRequest = (req) => {
  if (req.cookies?.[ACCESS_TOKEN_COOKIE]) {
    return req.cookies[ACCESS_TOKEN_COOKIE];
  }
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
};

const jwtOptions = {
  secretOrKey: config.jwt.secret,
  jwtFromRequest,
};

const jwtVerify = async (payload, done) => {
  try {
    if (payload.type !== tokenTypes.ACCESS) {
      throw new Error('Invalid token type');
    }
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'active') {
      return done(null, false);
    }
    // Pass user to done; req.impersonation is set in auth middleware from payload
    done(null, user);
  } catch (error) {
    done(error, false);
  }
};

const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);

export { jwtStrategy };
