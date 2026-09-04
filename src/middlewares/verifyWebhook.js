import crypto from 'crypto';
import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';

/**
 * Normalise an address for comparison.
 *
 * Node reports IPv4 clients over a dual-stack socket as "::ffff:1.2.3.4", so the
 * mapped prefix has to come off before an allowlist entry can ever match.
 */
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/** Warn once per process, not per request. */
let warnedBadEntries = false;

/**
 * Say so when an allowlist entry can never match.
 *
 * The 403 log tells an operator to "add the source IP", and the natural response to a
 * provider rotating IPs is to paste a CIDR range. Exact-string matching would accept that
 * silently and deny every request forever, which looks identical to a misconfigured proxy.
 */
function warnOnUnusableAllowlistEntries(allowed) {
  if (warnedBadEntries) return;
  const unusable = allowed.filter((e) => e.includes('/') || e.includes('*'));
  if (!unusable.length) return;
  warnedBadEntries = true;
  logger.error(
    `[Bolna webhook] BOLNA_WEBHOOK_ALLOWED_IPS contains ${unusable.join(', ')}, which will NEVER match — ` +
      'entries are compared as exact IP strings and CIDR/wildcards are not supported. List each IP separately.'
  );
}

/**
 * Gate the Bolna webhook endpoints.
 *
 * Bolna authenticates by SOURCE IP and does not send a shared secret, so the previous
 * secret-only check had no working configuration: with no secret it called next() for
 * any anonymous caller on the internet (dev/staging), and with a secret set it 401'd
 * genuine Bolna traffic. Three routes were exposed that way, including the bare domain
 * root, with no rate limit.
 *
 * Order of checks, first match wins:
 *   1. Source IP is on the allowlist      -> accept. This is the real control.
 *   2. A secret is configured AND matches -> accept. Keeps a webhook proxy working.
 *   3. Explicit local-dev opt-in          -> accept, loudly.
 *   4. Otherwise                          -> 403, logged.
 *
 * Default is now DENY. Safe to switch on: both Bolna agents currently have
 * `webhook_url = null`, so no live traffic depends on these endpoints today.
 *
 * `req.ip` honours Express `trust proxy`, and it fails in BOTH directions:
 *  - Behind a load balancer with neither TRUST_PROXY_HOPS nor TRUST_PROXY set, req.ip is
 *    the balancer and nothing matches — the endpoint is dead but safe.
 *  - With TRUST_PROXY=true, Express takes the LEFTMOST X-Forwarded-For entry, which the
 *    client supplies, so the allowlist becomes trivially spoofable. Prefer an exact
 *    TRUST_PROXY_HOPS count, and make sure the Node port is not directly reachable —
 *    this whole control now rests on req.ip being trustworthy.
 *
 * Entries are matched as exact strings. CIDR is NOT supported; a range like
 * 13.203.39.0/24 would silently never match, so it is called out at startup instead.
 */
export function verifyBolnaWebhook(req, res, next) {
  const allowed = (config.webhooks?.bolnaAllowedIps || []).map(normalizeIp).filter(Boolean);
  const sourceIp = normalizeIp(req.ip);

  warnOnUnusableAllowlistEntries(allowed);

  if (allowed.length && sourceIp && allowed.includes(sourceIp)) return next();

  const secret = (config.webhooks?.bolnaSecret || '').trim();
  if (secret) {
    const header = String(req.get('x-bolna-webhook-secret') || req.get('X-Bolna-Webhook-Secret') || '');
    try {
      const a = Buffer.from(header, 'utf8');
      const b = Buffer.from(secret, 'utf8');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    } catch {
      /* fall through to deny */
    }
  }

  if (config.webhooks?.bolnaAllowInsecure) {
    logger.warn(
      `[Bolna webhook] BOLNA_WEBHOOK_ALLOW_INSECURE is on — accepting unverified caller ${sourceIp || 'unknown'} ` +
        'on a Bolna webhook route. This must never be set on a shared or public host.'
    );
    return next();
  }

  // Logged, unlike before: a flood of forged webhook attempts previously produced no
  // signal at all, which is the one place it is most needed.
  logger.warn(
    `[Bolna webhook] rejected ${req.method} ${req.originalUrl} from ${sourceIp || 'unknown source'} ` +
      `(allowlist=${allowed.length} entr${allowed.length === 1 ? 'y' : 'ies'}, secret=${secret ? 'set' : 'unset'}). ` +
      'If this was genuine Bolna traffic, add the source IP to BOLNA_WEBHOOK_ALLOWED_IPS ' +
      'and check TRUST_PROXY_HOPS is correct for this deployment.'
  );
  return res.status(httpStatus.FORBIDDEN).json({ success: false, error: 'Forbidden' });
}
