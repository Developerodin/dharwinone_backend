/**
 * Plivo phone-number client — search available numbers and buy them.
 *
 * Auth is HTTP Basic (Auth ID + Auth Token). We use the official `plivo` SDK,
 * which wraps the Plivo REST API:
 *   - Search: GET  /v1/Account/{auth_id}/PhoneNumber/      → client.numbers.search()
 *   - Buy:    POST /v1/Account/{auth_id}/PhoneNumber/{n}/  → client.numbers.buy()
 *
 * Buying is a real, paid action against the live Plivo account — gate it in the
 * route layer and confirm it in the UI.
 */

import plivo from 'plivo';
import logger from '../config/logger.js';
import config from '../config/config.js';

/**
 * Build a Plivo SDK client from configured credentials.
 * @returns {{ client: import('plivo').Client } | { error: string }}
 */
function getClient() {
  const authId = config.plivo.authId;
  const authToken = config.plivo.authToken;
  if (!authId || !authToken) {
    return {
      error:
        'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN are not set. Add them to .env to use Plivo phone numbers.',
    };
  }
  return { client: new plivo.Client(authId, authToken) };
}

/** Pick the first defined value among candidate keys (handles snake_case + camelCase SDK shapes). */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

/**
 * Normalize one Plivo available-number record to a stable client shape.
 * @param {Object} n
 */
function normalizeNumber(n) {
  return {
    number: pick(n, 'number', 'phoneNumber'),
    type: pick(n, 'type', 'numberType') || '',
    region: pick(n, 'region', 'state') || '',
    city: pick(n, 'city') || '',
    country: pick(n, 'country', 'countryIso', 'country_iso') || '',
    monthlyRentalRate: pick(n, 'monthlyRentalRate', 'monthly_rental_rate', 'rentalRate') ?? null,
    setupRate: pick(n, 'setupRate', 'setup_rate') ?? null,
    voiceEnabled: Boolean(pick(n, 'voiceEnabled', 'voice_enabled')),
    smsEnabled: Boolean(pick(n, 'smsEnabled', 'sms_enabled')),
    mmsEnabled: Boolean(pick(n, 'mmsEnabled', 'mms_enabled')),
    voiceRate: pick(n, 'voiceRate', 'voice_rate') ?? null,
    smsRate: pick(n, 'smsRate', 'sms_rate') ?? null,
    restriction: pick(n, 'restriction') || '',
    restrictionText: pick(n, 'restrictionText', 'restriction_text') || '',
  };
}

/** Extract a clean human message from a Plivo SDK error. */
function plivoErrorMessage(err) {
  if (!err) return 'Unknown Plivo error.';
  const fromBody =
    err.message ||
    (err.error && (err.error.message || err.error.error)) ||
    (typeof err.body === 'object' && (err.body.error || err.body.message));
  return String(fromBody || err);
}

/**
 * Search available numbers to buy.
 * @param {Object} params - { countryIso, type?, pattern?, services?, city?, region?, limit?, offset? }
 * @returns {Promise<{ success: boolean, numbers?: Object[], hasMore?: boolean, offset?: number, limit?: number, error?: string }>}
 */
async function searchAvailableNumbers({
  countryIso,
  type,
  pattern,
  services,
  city,
  region,
  limit,
  offset,
} = {}) {
  const { client, error } = getClient();
  if (error) return { success: false, error };
  if (!countryIso) return { success: false, error: 'countryIso is required.' };

  const pageLimit = Math.min(20, Math.max(1, Number(limit) || 20));
  const pageOffset = Math.max(0, Number(offset) || 0);

  const optional = {};
  if (type) optional.type = type;
  if (pattern) optional.pattern = pattern;
  if (services) optional.services = services;
  if (city) optional.city = city;
  if (region) optional.region = region;
  optional.limit = pageLimit;
  optional.offset = pageOffset;

  try {
    const res = await client.numbers.search(String(countryIso).toUpperCase(), optional);
    // SDK returns an array of results with a non-enumerable `.meta` ({ total_count, limit, offset }).
    const list = Array.isArray(res) ? res : res?.objects || res?.objs || [];
    const numbers = list.map(normalizeNumber).filter((n) => n.number);
    const meta = (Array.isArray(res) && res.meta) || res?.meta || {};
    const totalCount = Number(meta.total_count);
    // Prefer Plivo's reported total; fall back to a full-page heuristic if meta is absent.
    const hasMore = Number.isFinite(totalCount)
      ? pageOffset + numbers.length < totalCount
      : list.length >= pageLimit;
    return {
      success: true,
      numbers,
      hasMore,
      offset: pageOffset,
      limit: pageLimit,
      total: Number.isFinite(totalCount) ? totalCount : undefined,
    };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo number search failed (country=${countryIso}, type=${type}): ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Buy (rent) an available number. Real paid action.
 * @param {string} number - E.164-ish phone number from a search result
 * @returns {Promise<{ success: boolean, number?: string, message?: string, error?: string }>}
 */
async function buyNumber(number) {
  const { client, error } = getClient();
  if (error) return { success: false, error };
  if (!number) return { success: false, error: 'number is required.' };

  try {
    const res = await client.numbers.buy(String(number).trim());
    const message = pick(res, 'message') || 'Number purchased successfully.';
    logger.info(`Plivo number purchased: ...${String(number).slice(-4)}`);
    return { success: true, number: String(number).trim(), message };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo number buy failed (number=...${String(number).slice(-4)}): ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Fetch the call recording(s) Plivo stored for a given call.
 *
 * Plivo records DUAL-CHANNEL by default (agent + caller in one file), so this is
 * the source of truth for the full two-sided audio — unlike Bolna's own
 * `recording_url`, which only carries the agent leg. Pass the Plivo call UUID,
 * which Bolna exposes as `telephony_data.provider_call_id`.
 *
 * @param {string} callUuid - Plivo call UUID (Bolna's telephony_data.provider_call_id)
 * @returns {Promise<{ success: boolean, recordings?: Object[], error?: string }>}
 */
async function getCallRecordings(callUuid) {
  const { client, error } = getClient();
  if (error) return { success: false, error };
  if (!callUuid) return { success: false, error: 'callUuid is required.' };

  try {
    const res = await client.recordings.list({ callUuid: String(callUuid).trim() });
    const list = Array.isArray(res) ? res : res?.objects || [];
    const recordings = list.map((r) => ({
      recordingId: pick(r, 'recordingId', 'recording_id'),
      callUuid: pick(r, 'callUuid', 'call_uuid'),
      recordingUrl: pick(r, 'recordingUrl', 'recording_url'),
      durationMs: pick(r, 'recordingDurationMs', 'recording_duration_ms'),
      type: pick(r, 'recordingType', 'recording_type'),
      addTime: pick(r, 'addTime', 'add_time'),
    }));
    return { success: true, recordings };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo recording fetch failed (callUuid=${callUuid}): ${message}`);
    return { success: false, error: message };
  }
}

export default {
  getClient,
  searchAvailableNumbers,
  buyNumber,
  getCallRecordings,
};
