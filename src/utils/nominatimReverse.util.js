/**
 * One-shot reverse geocode for activity-log client geo (legacy CSV header path).
 * Respects Nominatim usage policy: identifiable User-Agent, no bulk use.
 * @see https://operations.osmfoundation.org/policies/nominatim/
 */

const DEFAULT_UA =
  'Dharwin-ActivityLog/1.0 (server reverse-geocode; +https://www.openstreetmap.org/copyright)';

const PLACE_MAX_LEN = 128;

/**
 * @param {unknown} v
 * @returns {string|null}
 */
const trimPlace = (v) => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, PLACE_MAX_LEN);
  return s || null;
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{ timeoutMs?: number, userAgent?: string }} [opts]
 * @returns {Promise<{ city: string|null, region: string|null, country: string|null }|null>}
 */
export async function nominatimReversePlace(lat, lng, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 4500;
  const ua = opts.userAgent ?? DEFAULT_UA;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'json');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', '10');
  url.searchParams.set('addressdetails', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': ua,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data && typeof data.address === 'object' && data.address !== null ? data.address : {};
    const city = trimPlace(
      addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.county
    );
    const region = trimPlace(addr.state || addr.region);
    const country = trimPlace(addr.country);
    if (!city && !region && !country) return null;
    return { city, region, country };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
