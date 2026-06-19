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
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import plivo from 'plivo';
import logger from '../config/logger.js';
import config from '../config/config.js';
import PlivoBrowserCallIntent from '../models/plivoBrowserCallIntent.model.js';

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

/** Extract a clean human message from a Plivo SDK error (never "[object Object]"). */
function plivoErrorMessage(err) {
  if (!err) return 'Unknown Plivo error.';
  if (typeof err === 'string') return err;
  // Plivo validation errors arrive as objects, e.g. { alias: ["Invalid ..."] }.
  // Flatten them to a string so they never collapse to "[object Object]".
  const flatten = (v) => {
    if (v == null) return undefined;
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  };
  const candidates = [
    flatten(err.message),
    err.error && (err.error.message || err.error.error || flatten(err.error)),
    typeof err.body === 'object' ? err.body.error || err.body.message : err.body,
    err.statusCode && `HTTP ${err.statusCode}`,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  // Last resort: stringify so the real Plivo payload is never hidden behind [object Object].
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
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

/** Restore leading "+" when Plivo/browser send digits-only E.164. */
function toE164ish(value) {
  const t = String(value || '').trim();
  if (!t) return '';
  if (t.startsWith('+')) return t;
  if (/^\d+$/.test(t)) return `+${t}`;
  return t;
}

/**
 * Plivo browser-SDK answer webhooks often send `To` as a SIP URI
 * (e.g. 918755887760@phone.plivo.com), not bare E.164 — normalize before Dial XML.
 */
function normalizePlivoDialTarget(value) {
  const t = String(value || '').trim();
  if (!t) return '';
  const sipUser = t.match(/^(?:sip:)?(\+?\d+)@/i);
  if (sipUser) return toE164ish(sipUser[1]);
  return toE164ish(t);
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
// Plivo SIP endpoint username must be alphanumeric. Plivo APPENDS random digits
// on create (e.g. 'dharwinweb' -> 'dharwinweb293710175497378'), so this is only
// a prefix — the real username comes back in the create/list response.
const WEBRTC_ENDPOINT_USERNAME_PREFIX = 'dharwinweb';
// Alias is how we re-find OUR endpoint across restarts (username is unknowable
// up front). Plivo alias allows only letters/numbers/-/_ — NO spaces.
const WEBRTC_ENDPOINT_ALIAS = 'dharwin-webrtc-dialer';
// ponytail: process-lifetime cache of the resolved real username — provisioning
// is idempotent, so after one success skip the Plivo round-trips. null = not yet.
let webrtcUsername = null;

// Plivo often does not forward browser-SDK X-PH-* headers to the answer webhook.
// The UI registers {dest, callerId} here immediately before client.call(); sdk-answer
// consumes it when the webhook arrives without a usable caller ID.
const BROWSER_CALL_INTENT_TTL_MS = 120000;
const browserCallIntents = new Map();

function purgeExpiredBrowserCallIntents() {
  const now = Date.now();
  for (const [dest, entry] of browserCallIntents) {
    if (entry.expiresAt <= now) browserCallIntents.delete(dest);
  }
}

/**
 * Store outbound browser-call metadata keyed by normalized destination E.164.
 * Persists to Mongo when connected so Render multi-instance webhooks can read it.
 * @param {{ toNumber: string, callerId: string }} p
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function registerBrowserCallIntent({ toNumber, callerId } = {}) {
  const dest = normalizePlivoDialTarget(toNumber);
  const from = normalizePlivoDialTarget(callerId);
  if (!isE164(dest)) return { success: false, error: 'toNumber must be E.164 (e.g. +14155550100).' };
  if (!isE164(from)) return { success: false, error: 'callerId must be E.164.' };
  const expiresAt = new Date(Date.now() + BROWSER_CALL_INTENT_TTL_MS);
  purgeExpiredBrowserCallIntents();
  browserCallIntents.set(dest, { callerId: from, expiresAt: expiresAt.getTime() });
  if (mongoose.connection.readyState === 1) {
    await PlivoBrowserCallIntent.findOneAndUpdate(
      { dest },
      { dest, callerId: from, expiresAt },
      { upsert: true, new: true }
    );
  }
  return { success: true };
}

/** @param {string} destE164 */
async function consumeBrowserCallIntent(destE164) {
  if (mongoose.connection.readyState === 1) {
    const doc = await PlivoBrowserCallIntent.findOneAndDelete({
      dest: destE164,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (doc) {
      browserCallIntents.delete(destE164);
      return { callerId: doc.callerId };
    }
  }
  purgeExpiredBrowserCallIntents();
  const entry = browserCallIntents.get(destE164);
  if (!entry || entry.expiresAt <= Date.now()) {
    browserCallIntents.delete(destE164);
    return null;
  }
  browserCallIntents.delete(destE164);
  return { callerId: entry.callerId };
}

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
  if (webrtcUsername) return { success: true, username: webrtcUsername };

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

    // Endpoint — find OUR endpoint by alias (username is unknowable up front
    // because Plivo appends random digits on create), else create one. Password
    // is required by Plivo but never leaves the server; browsers authenticate
    // with the access token.
    const endpoints = listItems(await client.endpoints.list());
    let endpoint = endpoints.find((e) => pick(e, 'alias') === WEBRTC_ENDPOINT_ALIAS);
    if (!endpoint) {
      // Plivo requires an alphanumeric password — hex keeps it to [0-9a-f].
      const password = crypto.randomBytes(16).toString('hex');
      // SDK signature: create(username, password, alias, appId) — appId is positional.
      // Alias must be [A-Za-z0-9_-] (no spaces). The response carries the real,
      // digit-suffixed username we must use for the access token.
      endpoint = await client.endpoints.create(
        WEBRTC_ENDPOINT_USERNAME_PREFIX,
        password,
        WEBRTC_ENDPOINT_ALIAS,
        appId
      );
    }

    const realUsername = pick(endpoint, 'username');
    if (!realUsername) {
      return { success: false, error: 'Plivo endpoint provisioned without a username.' };
    }
    webrtcUsername = realUsername;
    return { success: true, username: webrtcUsername };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo WebRTC provisioning failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * plivo-browser-sdk v2 gates client.call() on JWT claim `per.voice.outgoing_allow`.
 * The Node `plivo` SDK v4 only emits `grants.voice` — login succeeds but outbound
 * calls are rejected client-side with "Outgoing call permission not granted".
 */
function enrichAccessTokenForBrowserSdk(plivoJwt) {
  const [headerB64, payloadB64] = plivoJwt.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  if (payload.grants?.voice && !payload.per?.voice) {
    payload.per = { voice: { ...payload.grants.voice } };
  }
  return jwt.sign(payload, config.plivo.authToken, {
    algorithm: 'HS256',
    header: { typ: header.typ || 'JWT', cty: header.cty || 'plivo;v=1' },
  });
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
    return {
      success: true,
      token: enrichAccessTokenForBrowserSdk(token.toJwt()),
      username: ensured.username,
    };
  } catch (err) {
    const message = plivoErrorMessage(err);
    logger.error(`Plivo WebRTC token mint failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Answer XML for a browser-SDK outbound call. Plivo POSTs the dialed number as
 * `To`; the chosen caller ID may arrive as `X-PH-callerId` (often missing).
 * Falls back to a short-lived intent registered by POST /plivo/browser-call-intent.
 */
async function sdkAnswerXml({ to, callerId }) {
  const dest = normalizePlivoDialTarget(to);
  let from = normalizePlivoDialTarget(callerId);
  let intentSource = isE164(from) ? 'header' : null;
  if (!isE164(from) && isE164(dest)) {
    const intent = await consumeBrowserCallIntent(dest);
    if (intent) {
      from = intent.callerId;
      intentSource = 'intent';
    }
  }
  if (!isE164(dest) || !isE164(from)) {
    logger.warn(
      `Plivo sdkAnswerXml missing dial params (dest=${dest || 'empty'}, from=${from || 'empty'}, intent=${intentSource || 'none'})`
    );
    return null;
  }
  if (intentSource === 'intent') {
    logger.info(`Plivo sdk-answer using browser call intent for dest ...${dest.slice(-4)}`);
  }
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
  enrichAccessTokenForBrowserSdk,
  mintWebrtcToken,
  normalizePlivoDialTarget,
  registerBrowserCallIntent,
  sdkAnswerXml,
};
