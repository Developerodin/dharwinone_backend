import geoip from 'geoip-lite';

/**
 * Strip IPv4-mapped IPv6 prefix for checks and geoip-lite (IPv4 only).
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIpForLookup(ip) {
  if (!ip || typeof ip !== 'string') return '';
  const t = ip.trim();
  if (t.startsWith('::ffff:')) return t.slice(7);
  return t;
}

/**
 * True for loopback, private LAN, link-local, and other non-public routable addresses.
 * GeoIP databases do not map these to a real geography.
 * @param {string} ip
 * @returns {boolean}
 */
export function isNonPublicIp(ip) {
  const raw = (ip || '').trim().toLowerCase();
  if (!raw) return true;

  if (raw === '::1') return true;
  if (raw.startsWith('fe80:')) return true;
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true;

  const v4 = normalizeIpForLookup(raw);
  if (v4.includes(':')) {
    return false;
  }

  const parts = v4.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Merge stored geo (e.g. Cloudflare country) with GeoLite lookup from `ip` when location is still empty.
 * Local/private IPs get a human label instead of "unknown".
 *
 * @param {string|null|undefined} ip
 * @param {{ country?: string|null, region?: string|null, city?: string|null }|null|undefined} storedGeo
 * @returns {{ country?: string|null, region?: string|null, city?: string|null }}
 */
export function resolveGeoForDisplay(ip, storedGeo) {
  const geo = storedGeo && typeof storedGeo === 'object' ? { ...storedGeo } : {};
  const hasAny =
    !!(geo.country && String(geo.country).trim()) ||
    !!(geo.region && String(geo.region).trim()) ||
    !!(geo.city && String(geo.city).trim());
  if (hasAny) return geo;

  if (!ip || typeof ip !== 'string' || !ip.trim()) return geo;

  if (isNonPublicIp(ip)) {
    return { ...geo, city: 'Local / private network' };
  }

  try {
    const trimmed = ip.trim();
    let hit = geoip.lookup(trimmed);
    if (!hit) {
      const n = normalizeIpForLookup(trimmed);
      if (n !== trimmed) hit = geoip.lookup(n);
    }
    if (!hit) return { ...geo, city: 'Unknown' };
    return {
      country: hit.country || null,
      region: hit.region || null,
      city: hit.city || null,
    };
  } catch {
    return geo;
  }
}
