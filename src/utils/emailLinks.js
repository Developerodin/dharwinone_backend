import config from '../config/config.js';

/**
 * Resolve the frontend base URL for email links.
 * Tries (in order):
 * 1. Explicit override passed in
 * 2. Request Origin header (when user triggers action from frontend)
 * 3. Request Referer header (fallback - extract origin)
 * 4. X-Forwarded-Host + X-Forwarded-Proto (reverse proxy)
 * 5. config.frontendBaseUrl
 * 6. localhost:3001 (development fallback)
 * @param {Object} [req] - Express request (optional)
 * @param {string} [override] - Explicit base URL override
 *  @param {string} [req.headers.referer]
 *  @param {string} [req.headers['x-forwarded-host']]
 *  @param {string} [req.headers['x-forwarded-proto']]
 * @param {string} [override] - Explicit base URL override
 * @returns {string} Frontend base URL (no trailing slash)
 */
export function getFrontendBaseUrl(req = null, override = null) {
  const defaultBase = (config.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '');

  if (override && typeof override === 'string' && override.trim()) {
    return override.trim().replace(/\/$/, '');
  }

  if (req && req.headers) {
    // 1. Origin header (most reliable - browser sends this with frontend requests)
    const origin = req.headers.origin || req.headers.Origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.origin) return url.origin;
      } catch {
        /* ignore invalid Origin */
      }
    }

    // 2. Referer - extract origin (e.g. https://app.example.com/reset → https://app.example.com)
    const referer = req.headers.referer || req.headers.Referer;
    if (referer) {
      try {
        const url = new URL(referer);
        if (url.origin) return url.origin;
      } catch {
        /* ignore */
      }
    }

    // 3. X-Forwarded-Host + X-Forwarded-Proto (reverse proxy - may be backend host, use only if not API path)
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers['X-Forwarded-Host'];
    const forwardedProto = req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'] || 'https';
    if (forwardedHost) {
      const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost.split(',')[0].trim();
      const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto.split(',')[0].trim();
      if (host && !host.match(/^api\./) && !host.includes(':3000')) {
        return `${proto}://${host}`.replace(/\/$/, '');
      }
    }
  }

  return defaultBase;
}
