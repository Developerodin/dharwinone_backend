import config from '../config/config.js';
import logger from '../config/logger.js';

/** Server-side verification endpoints. All three take form-encoded secret+response. */
const VERIFY_URLS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

const VERIFY_TIMEOUT_MS = 5000;

/** Warn once per process, so an unconfigured deploy is visible without flooding the log. */
let warnedUnconfigured = false;

function reject(res, message, errorCode) {
  return res.status(400).json({ code: 400, message, errorCode });
}

/**
 * Verify the captcha token on the public apply form.
 *
 * What this replaces: a gate whose first line was
 *   if (String(process.env.CAPTCHA_REQUIRED || '').toLowerCase() !== 'true') return next();
 * with CAPTCHA_REQUIRED unset and absent from the config schema — so there was no check
 * at all. Even in its enabled branch it only asserted the token was a non-empty string;
 * provider verification was a TODO.
 *
 * That matters more here than on a normal signup, because this route places an outbound
 * AI voice call to a caller-supplied phone number, before any email verification. Without
 * a working captcha it is a robocall trigger open to the internet, bounded only by a
 * 45/hour/IP rate limit.
 *
 * Enforcement turns on automatically once CAPTCHA_PROVIDER and CAPTCHA_SECRET are both
 * set. Until then the route stays open and logs a warning on first use: failing closed by
 * default would take the live apply form down, which is not this middleware's call to make.
 */
export async function verifyCaptcha(req, res, next) {
  const { provider, secret, requireTokenOnly } = config.captcha || {};

  // Header only, on purpose. This middleware runs BEFORE multer so an unverified caller
  // cannot force a file upload, which means the multipart body is not parsed yet and
  // `req.body.captchaToken` is always empty here. A body fallback would read as a
  // supported transport while never firing. `x-captcha-token` is allow-listed in the
  // CORS config so the browser preflight permits it.
  const token = String(req.headers['x-captcha-token'] || '').trim();

  const configured = Boolean(provider && secret && VERIFY_URLS[provider]);

  if (!configured) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn(
        '[captcha] No provider configured — the public apply form is UNPROTECTED. ' +
          'This route dials an outbound AI voice call to a caller-supplied number. ' +
          'Set CAPTCHA_PROVIDER (turnstile|hcaptcha|recaptcha) and CAPTCHA_SECRET to enforce.'
      );
    }
    // Legacy behaviour: demand a token be present, without being able to verify it.
    if (requireTokenOnly && !token) {
      return reject(res, 'Captcha verification required', 'CAPTCHA_REQUIRED');
    }
    return next();
  }

  if (!token) return reject(res, 'Captcha verification required', 'CAPTCHA_REQUIRED');

  const body = new URLSearchParams({ secret, response: token });
  if (req.ip) body.set('remoteip', String(req.ip));

  let verified = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const upstream = await fetch(VERIFY_URLS[provider], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      const data = await upstream.json().catch(() => ({}));
      verified = data?.success === true;
      if (!verified) {
        logger.warn(
          `[captcha] ${provider} rejected a token from ${req.ip || 'unknown'}: ` +
            `${JSON.stringify(data?.['error-codes'] || data?.error_codes || 'no error codes')}`
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    // Fail CLOSED on a provider outage. The protected action places phone calls and costs
    // money, so a brief false rejection is cheaper than an open door.
    logger.error(`[captcha] ${provider} verification failed to complete: ${err?.message || err}`);
    return reject(res, 'Captcha verification unavailable. Please try again.', 'CAPTCHA_UNAVAILABLE');
  }

  if (!verified) return reject(res, 'Captcha verification failed', 'CAPTCHA_INVALID');
  return next();
}
