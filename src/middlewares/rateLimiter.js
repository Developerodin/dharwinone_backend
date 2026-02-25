import rateLimit from 'express-rate-limit';
import config from '../config/config.js';

const authLimiter = rateLimit({
  windowMs: (config.rateLimit?.authWindowMinutes ?? 15) * 60 * 1000,
  max: config.rateLimit?.authMax ?? 200,
  skipSuccessfulRequests: true,
  message: { message: 'Too many sign-in attempts. Please try again later.' },
});

const attendancePunchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user && req.user.id ? String(req.user.id) : req.ip),
  message: { message: 'Too many punch requests. Please try again in a minute.' },
});

export {
  authLimiter,
  attendancePunchLimiter,
};

