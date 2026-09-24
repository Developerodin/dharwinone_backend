import crypto from 'crypto';
import config from '../config/config.js';
import logger from '../config/logger.js';

const normalizeIp = (ip) => {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
};

/**
 * Gate Bolna mid-call custom functions (/v1/ai-tools/*).
 *
 * Bearer `config.bolna.toolToken` compared with timingSafeEqual. Unset token ⇒ 503 (feature off).
 * The Bolna webhook IP allowlist is only LOGGED here, not enforced: tool calls may egress from
 * different Bolna IPs than webhooks, and a wrong allowlist would silently kill every booking.
 * Defence in depth instead: recent-CallRecord guard in the controller + recruiter approval.
 */
export function verifyBolnaTool(req, res, next) {
  const token = config.bolna?.toolToken || '';
  if (!token) {
    return res.status(503).json({ ok: false, message: "I'll email you a link to choose a time." });
  }
  const header = String(req.get('authorization') || '');
  const presented = header.replace(/^Bearer\s+/i, '');
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn(`[ai-tools] rejected tool call from ${normalizeIp(req.ip)} (bad or missing bearer)`);
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const allowed = (config.webhooks?.bolnaAllowedIps || []).map(normalizeIp).filter(Boolean);
  const ip = normalizeIp(req.ip);
  if (allowed.length && !allowed.includes(ip)) {
    logger.warn(`[ai-tools] valid token from non-allowlisted IP ${ip} — add to BOLNA_WEBHOOK_ALLOWED_IPS if this is Bolna`);
  }
  return next();
}

export default verifyBolnaTool;
