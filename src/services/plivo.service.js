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

import crypto from 'crypto';
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

/**
 * Normalize one Plivo owned/rented-number record to a stable client shape.
 * Source: client.numbers.list() — the numbers already on the account.
 * @param {Object} n
 */
function normalizeOwnedNumber(n) {
  const carrier = n && (n.carrier || n.Carrier);
  return {
    number: pick(n, 'number', 'phoneNumber'),
    alias: pick(n, 'alias') || '',
    type: pick(n, 'numberType', 'type', 'number_type') || '',
    region: pick(n, 'region', 'state') || '',
    country: pick(n, 'country', 'countryIso', 'country_iso') || '',
    addedOn: pick(n, 'addedOn', 'added_on') || '',
    application: pick(n, 'application') || '',
    monthlyRentalRate: pick(n, 'monthlyRentalRate', 'monthly_rental_rate') ?? null,
    voiceEnabled: Boolean(pick(n, 'voiceEnabled', 'voice_enabled')),
    smsEnabled: Boolean(pick(n, 'smsEnabled', 'sms_enabled')),
    mmsEnabled: Boolean(pick(n, 'mmsEnabled', 'mms_enabled')),
    carrier: (carrier && (carrier.type || carrier.Type)) || '',
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
 * List numbers already rented/owned on the connected Plivo account.
 * @param {Object} params - { type?, alias?, limit?, offset? }
 * @returns {Promise<{ success: boolean, numbers?: Object[], total?: number, error?: string }>}
 */
async function listOwnedNumbers({ type, alias, limit, offset } = {}) {
  const { client, error } = getClient();
  if (error) return { success: false, error };

  const pageLimit = Math.min(20, Math.max(1, Number(limit) || 20));
  const pageOffset = Math.max(0, Number(offset) || 0);
  const optional = { limit: pageLimit, offset: pageOffset };
  if (type) optional.numberType = type;
  if (alias) optional.alias = alias;

  try {
    const res = await client.numbers.list(optional);
    const list = Array.isArray(res) ? res : res?.objects || res?.objs || [];
    const numbers = list.map(normalizeOwnedNumber).filter((n) => n.number);
    const meta = (Array.isArray(res) && res.meta) || res?.meta || {};
    const totalCount = Number(meta.total_count);
    return {
      success: true,
      numbers,
      total: Number.isFinite(totalCount) ? totalCount : numbers.length,
    };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo owned-number list failed: ${message}`);
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

/** E.164-ish sanity check: leading +, 8–15 digits. Plivo rejects bad numbers anyway, but fail fast + cheap. */
function isE164(num) {
  return /^\+[1-9]\d{7,14}$/.test(String(num || '').trim());
}

/**
 * HMAC of the answer-XML params so the public /plivo/answer endpoint can't be
 * abused to dial arbitrary numbers (toll fraud). Only URLs we mint verify.
 */
function callSignature(toNumber, callerId) {
  return crypto
    .createHmac('sha256', config.jwt.secret)
    .update(`${toNumber}|${callerId}`)
    .digest('hex');
}

function verifyCallSignature(toNumber, callerId, sig) {
  const expected = callSignature(toNumber, callerId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Plivo answer XML that bridges the answered agent leg to the dialed number, showing the bought number as caller ID. */
function bridgeAnswerXml({ toNumber, callerId }) {
  const response = new plivo.Response();
  const dial = response.addDial({ callerId: String(callerId) });
  dial.addNumber(String(toNumber));
  return response.toXML();
}

/**
 * Click-to-call bridge. Plivo first rings the agent's own phone (`agentPhone`);
 * when they answer it fetches our signed answer URL, which dials `toNumber` and
 * presents the bought `callerId`. No browser audio — the agent talks on their phone.
 * @param {Object} p - { agentPhone, toNumber, callerId }
 * @returns {Promise<{ success: boolean, requestUuid?: string, message?: string, error?: string }>}
 */
async function placeBridgeCall({ agentPhone, toNumber, callerId } = {}) {
  const { client, error } = getClient();
  if (error) return { success: false, error };
  if (!isE164(agentPhone)) return { success: false, error: 'agentPhone must be E.164 (e.g. +14155550100).' };
  if (!isE164(toNumber)) return { success: false, error: 'toNumber must be E.164 (e.g. +14155550100).' };
  if (!isE164(callerId)) return { success: false, error: 'callerId (your bought number) must be E.164.' };

  // Caller-ID must be a number this account actually owns — block spoofing an
  // arbitrary number as the outbound caller ID. (Plivo also rejects non-owned
  // caller IDs, but fail fast here with a clear authorization error.)
  try {
    const ownedNum = await client.numbers.get(String(callerId).trim());
    if (pick(ownedNum, 'voiceEnabled', 'voice_enabled') === false) {
      return { success: false, error: 'callerId is not voice-enabled on this account.' };
    }
  } catch (err) {
    return { success: false, error: 'callerId is not a phone number owned by this account.' };
  }

  // Plivo's servers fetch the answer URL — localhost is unreachable and Plivo
  // rejects it with "answer_url parameter is not valid". Fail with a clear hint.
  const base = config.plivo.answerBaseUrl || config.backendPublicUrl;
  if (/localhost|127\.0\.0\.1|\b0\.0\.0\.0\b/.test(base)) {
    return {
      success: false,
      error:
        'Call answer URL is not publicly reachable. Set PLIVO_ANSWER_BASE_URL (or BACKEND_PUBLIC_URL) to a public https URL — e.g. an ngrok tunnel in dev — so Plivo can fetch the call XML.',
    };
  }

  const sig = callSignature(toNumber, callerId);
  const answerUrl =
    `${base}/v1/public/plivo/answer` +
    `?to=${encodeURIComponent(toNumber)}&callerId=${encodeURIComponent(callerId)}&sig=${sig}`;

  try {
    const res = await client.calls.create(callerId, agentPhone, answerUrl, { answerMethod: 'GET' });
    logger.info(`Plivo bridge call started (agent=...${agentPhone.slice(-4)} → ...${toNumber.slice(-4)})`);
    return {
      success: true,
      requestUuid: pick(res, 'requestUuid', 'request_uuid'),
      message: pick(res, 'message') || 'Call initiated. Your phone will ring shortly.',
    };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo bridge call failed (to=...${String(toNumber).slice(-4)}): ${message}`);
    return { success: false, error: message };
  }
}

// --- WebRTC browser softphone (plivo-browser-sdk) ---------------------------
// One shared, outbound-only SIP endpoint + a Plivo Application whose answer_url
// is our public /v1/public/plivo/sdk-answer. Browsers log in with a short-lived
// access token (no password in the client) and place calls; Plivo fetches the
// answer XML which dials the target with the chosen bought number as caller ID.

const WEBRTC_APP_NAME = 'dharwin-webrtc-dialer';
const WEBRTC_ENDPOINT_USERNAME = 'dharwin-web';

function webrtcAnswerUrl() {
  const base = (config.plivo.answerBaseUrl || config.backendPublicUrl || '').replace(/\/$/, '');
  return `${base}/v1/public/plivo/sdk-answer`;
}

/** First defined of res.objects / res array (SDK list shapes vary). */
function listItems(res) {
  return Array.isArray(res) ? res : res?.objects || res?.objs || [];
}

/**
 * Idempotently ensure the shared WebRTC Application + endpoint exist and the
 * Application's answer_url points at this backend. Returns the endpoint username.
 * @returns {Promise<{ success: boolean, username?: string, error?: string }>}
 */
async function ensureWebrtcApp() {
  const { client, error } = getClient();
  if (error) return { success: false, error };

  const answerUrl = webrtcAnswerUrl();
  if (/localhost|127\.0\.0\.1|\b0\.0\.0\.0\b/.test(answerUrl)) {
    return {
      success: false,
      error:
        'WebRTC answer URL is not publicly reachable. Set PLIVO_ANSWER_BASE_URL (or BACKEND_PUBLIC_URL) to a public https URL so Plivo can fetch the call XML.',
    };
  }

  try {
    // Application — find by name, else create; keep its answer_url current.
    const apps = listItems(await client.applications.list());
    let app = apps.find((a) => pick(a, 'appName', 'app_name') === WEBRTC_APP_NAME);
    if (!app) {
      app = await client.applications.create(WEBRTC_APP_NAME, {
        answerUrl,
        answerMethod: 'POST',
      });
    } else if (pick(app, 'answerUrl', 'answer_url') !== answerUrl) {
      await client.applications.update(pick(app, 'appId', 'app_id'), { answerUrl, answerMethod: 'POST' });
    }
    const appId = pick(app, 'appId', 'app_id');

    // Endpoint — find by username, else create (password is required by Plivo but
    // never leaves the server; browsers authenticate with the access token).
    const endpoints = listItems(await client.endpoints.list());
    const existing = endpoints.find((e) => pick(e, 'username') === WEBRTC_ENDPOINT_USERNAME);
    if (!existing) {
      const password = crypto.randomBytes(18).toString('base64url');
      await client.endpoints.create(WEBRTC_ENDPOINT_USERNAME, password, 'Dharwin web dialer', { appId });
    }

    return { success: true, username: WEBRTC_ENDPOINT_USERNAME };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo WebRTC provisioning failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Mint a short-lived, outbound-only WebRTC access token for the shared endpoint.
 * @param {Object} p - { uid } caller-unique id for tracing (e.g. user id)
 * @returns {Promise<{ success: boolean, token?: string, username?: string, error?: string }>}
 */
async function mintWebrtcToken({ uid } = {}) {
  if (!config.plivo.authId || !config.plivo.authToken) {
    return { success: false, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN are not set.' };
  }
  const ensured = await ensureWebrtcApp();
  if (!ensured.success) return ensured;

  try {
    const token = new plivo.AccessToken(
      config.plivo.authId,
      config.plivo.authToken,
      ensured.username,
      { lifetime: 3600 },
      String(uid || ensured.username)
    );
    token.addVoiceGrants(false, true); // incoming: no, outgoing: yes
    return { success: true, token: token.toJwt(), username: ensured.username };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo WebRTC token mint failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Answer XML for a browser-SDK outbound call. Plivo POSTs the dialed number as
 * `To`; the chosen caller ID rides along as the `X-PH-callerId` custom header.
 * Falls back to the From leg's number if no caller ID was supplied.
 */
function sdkAnswerXml({ to, callerId }) {
  // The browser SDK may strip the leading "+"; restore it for E.164.
  const plus = (v) => {
    const t = String(v || '').trim();
    return t && !t.startsWith('+') && /^\d+$/.test(t) ? `+${t}` : t;
  };
  const dest = plus(to);
  const from = plus(callerId);
  if (!isE164(dest) || !isE164(from)) return null;
  return bridgeAnswerXml({ toNumber: dest, callerId: from });
}

export default {
  getClient,
  searchAvailableNumbers,
  buyNumber,
  listOwnedNumbers,
  getCallRecordings,
  placeBridgeCall,
  bridgeAnswerXml,
  verifyCallSignature,
  ensureWebrtcApp,
  mintWebrtcToken,
  sdkAnswerXml,
};
