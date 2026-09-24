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

/**
 * Shared by the EAD and visa scanners. Its own bucket on purpose: authStrictFlowLimiter
 * is shared with forgot-password, verify-email and registration, so an office behind one
 * NAT scanning documents would burn the allowance that password resets depend on.
 */
const documentScanLimiter = rateLimit({
  windowMs: (config.rateLimit?.documentScanWindowMinutes ?? 15) * 60 * 1000,
  max: config.rateLimit?.documentScanMax ?? 20,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many document scans. Please try again shortly.' },
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

/**
 * Public resume parse (AI). Tighter than apply — each call hits OpenAI.
 * Per-IP; in-memory store (same caveat as other limiters in this file).
 */
const publicResumeParseLimiter = rateLimit({
  windowMs: (config.rateLimit?.publicResumeParseWindowMinutes ?? 60) * 60 * 1000,
  max: config.rateLimit?.publicResumeParseMax ?? 15,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many resume parse attempts. Please try again later.' },
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

/**
 * Bolna mid-call tools (/v1/ai-tools). Bolna calls from a few shared IPs, so the ceiling is per
 * IP but generous. Replies 200 + spoken fallback so the agent never goes silent.
 */
const aiToolsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(200).json({ ok: false, message: 'Sorry, I cannot do that right now. Our team will follow up by email.' }),
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
 * Chat reactions. Route middleware is enough here, unlike message sending: reacting has no
 * Socket.IO path to leak through, so there is nothing for a service-level cap to catch that
 * this does not. Generous, because rapid emoji toggling is normal use, not abuse.
 */
const chatReactLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many reactions. Please try again in a minute.' },
});

/**
 * Chat file uploads (attachments, voice notes, group avatars). Each request can carry several
 * files straight to S3, so this is tighter than reactions. Runs after the membership check, so
 * only real members of the conversation spend budget.
 */
const chatUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many uploads. Please try again in a minute.' },
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
  documentScanLimiter,
  publicRegistrationLimiter,
  publicResumeParseLimiter,
  publicWriteLimiter,
  webhookLimiter,
  aiToolsLimiter,
  attendancePunchLimiter,
  jobsBrowseLimiter,
  chatAssistantLimiter,
  chatReactLimiter,
  chatUploadLimiter,
  teamsImport,
  teamsExport,
  emailLookupLimiterByUser,
  emailLookupLimiterByIp,
};

