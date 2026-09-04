import rateLimit from 'express-rate-limit';
import config from '../config/config.js';

/** Count only failed attempts (e.g. wrong password) — use on POST /auth/login only. */
const authLoginLimiter = rateLimit({
  windowMs: (config.rateLimit?.authWindowMinutes ?? 15) * 60 * 1000,
  max: config.rateLimit?.authMax ?? 80,
  skipSuccessfulRequests: true,
  message: { message: 'Too many sign-in attempts. Please try again later.' },
});

/**
 * Every request counts (including 2xx). Use on forgot-password, verify-email, reset-password,
 * and unauthenticated registration paths so email/SMTP abuse cannot bypass skipSuccessfulRequests.
 */
const authStrictFlowLimiter = rateLimit({
  windowMs: (config.rateLimit?.authStrictWindowMinutes ?? 15) * 60 * 1000,
  max: config.rateLimit?.authStrictMax ?? 30,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' },
});

/** Public registration / onboarding — tighter cap per IP. */
const publicRegistrationLimiter = rateLimit({
  windowMs: (config.rateLimit?.publicRegistrationWindowMinutes ?? 60) * 60 * 1000,
  max: config.rateLimit?.publicRegistrationMax ?? 45,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many registration attempts. Please try again later.' },
});

/**
 * Provider webhooks. Generous, because a real burst of call-completion callbacks is
 * legitimate — this exists to bound a forged flood, not to shape normal traffic.
 * The IP allowlist in verifyWebhook is the actual authentication; this is layer two.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many webhook requests.' },
});

/** Other unauthenticated POSTs under /v1/public (LiveKit, meetings, job apply, etc.). */
const publicWriteLimiter = rateLimit({
  windowMs: (config.rateLimit?.publicWriteWindowMinutes ?? 15) * 60 * 1000,
  max: config.rateLimit?.publicWriteMax ?? 120,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' },
});

const attendancePunchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user && req.user.id ? String(req.user.id) : req.ip),
  message: { message: 'Too many punch requests. Please try again in a minute.' },
});

/** Anonymous/authenticated job browse (GET /jobs/browse, GET /jobs/browse/:id) — per IP */
const jobsBrowseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.jobsBrowsePerMinute ?? 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again shortly.' },
});

const chatAssistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => (req.user && req.user.id ? String(req.user.id) : req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again in a minute.' },
});

/** Bulk team import — 5/hour per authenticated user (falls back to IP). */
const teamsImport = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  message: { code: 429, message: 'Too many team imports — try again later' },
});

/** Bulk team export — 20/hour per authenticated user (falls back to IP). */
const teamsExport = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  message: { code: 429, message: 'Too many team exports — try again later' },
});

/**
 * Exact-email contact lookup. TWO independent limiters, both applied. Spec §6.
 * A per-user limit alone is insufficient: a compromised account can distribute requests across
 * IPs, and multiple accounts can sit behind one source.
 *
 * ponytail: in-memory store, so caps are per process — on a multi-instance deploy the effective
 * limit is this value times the instance count. True of every limiter in this file; accepted for
 * consistency. Move to a shared store only if that headroom actually matters.
 */
const emailLookupLimiterByUser = rateLimit({
  windowMs: 60 * 1000,
  max: config.contactLookup?.perMinute ?? 20,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many lookups. Please try again in a minute.' },
});

const emailLookupLimiterByIp = rateLimit({
  windowMs: 60 * 1000,
  max: config.contactLookup?.perMinutePerIp ?? 40,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many lookups. Please try again in a minute.' },
});

export {
  authLoginLimiter,
  authStrictFlowLimiter,
  publicRegistrationLimiter,
  publicWriteLimiter,
  webhookLimiter,
  attendancePunchLimiter,
  jobsBrowseLimiter,
  chatAssistantLimiter,
  teamsImport,
  teamsExport,
  emailLookupLimiterByUser,
  emailLookupLimiterByIp,
};

