/**
 * Twilio Voice client — powered by the official `twilio` Node SDK.
 *
 * Responsibilities:
 *  - REST operations: search / purchase / list / release phone numbers,
 *    fetch call resources, end calls, toggle recordings.
 *  - Access Token (JWT) signing for the mobile Voice SDK (VoiceGrant).
 *  - TwiML generation for the TwiML App Voice URL (outbound) and the purchased
 *    number's Voice URL (inbound).
 *  - Webhook signature validation (X-Twilio-Signature).
 *
 * Credentials come from the validated config (TWILIO_AUTH_ID = Account SID,
 * TWILIO_AUTH_TOKEN, TWILIO_API_SID / TWILIO_API_SECRET, TWILIO_TWIML_APP_SID,
 * TWILIO_PHONE_NUMBER). The Plivo service is left untouched — Twilio runs
 * alongside it behind CALLING_PROVIDER until cutover.
 */

import crypto from 'crypto';
import https from 'https';
import http from 'http';
import twilio from 'twilio';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhone } from '../utils/phone.js';

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;
const VoiceResponse = twilio.twiml.VoiceResponse;

/** Identity used for the app's Voice SDK client, derived from the user id. */
export function clientIdentity(userId) {
  return `user_${String(userId)}`;
}

/** Parse a user id back out of a Twilio `client:user_<id>` From/To value. */
export function userIdFromClient(value) {
  if (!value) return '';
  const match = String(value).match(/(?:client:)?user_([a-f0-9]{24})/i);
  return match?.[1] || '';
}

function getConfig() {
  return { ...config.twilio };
}

/** Account-level REST client (Account SID + Auth Token). Memoised. */
let cachedClient = null;
let cachedClientKey = '';
function getClient() {
  const { accountSid, authToken } = getConfig();
  if (!accountSid || !authToken) return null;
  const key = `${accountSid}:${authToken}`;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = twilio(accountSid, authToken);
    cachedClientKey = key;
  }
  return cachedClient;
}

/** Whether outbound calling is configured (token signing + caller id). */
function isConfigured() {
  const { accountSid, authToken, apiKeySid, apiKeySecret, twimlAppSid } = getConfig();
  return Boolean(accountSid && authToken && apiKeySid && apiKeySecret && twimlAppSid);
}

/** E.164 with leading + for storage, display, and Twilio dial targets. */
function toE164(phone) {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Resolve a dial destination to a routable E.164 number, applying the same
 * country-code logic as the rest of the service (10-digit → +91 India default).
 * Naive `toE164` would turn "8290918154" into the invalid "+8290918154"; this
 * yields "+918290918154".
 */
function toDialE164(phone) {
  return normalizePhone(phone) || toE164(phone);
}

function normalizeWebhookBaseUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/$/, '').replace(/\/v1.*$/, '');
  }
}

function getWebhookBaseUrl() {
  const { webhookBaseUrl } = getConfig();
  return normalizeWebhookBaseUrl(webhookBaseUrl || config.backendPublicUrl || '');
}

function buildWebhookUrl(path) {
  const base = getWebhookBaseUrl();
  if (!base) return '';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/v1${suffix}`;
}

function describeError(err) {
  if (!err) return 'Twilio request failed';
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Run a Twilio REST operation with logging and a normalized
 * `{ success, data | error, status? }` envelope.
 * @param {string} label
 * @param {(client: import('twilio').Twilio) => Promise<unknown>} fn
 */
async function runTwilio(label, fn) {
  const client = getClient();
  if (!client) {
    return { success: false, error: 'TWILIO_AUTH_ID and TWILIO_AUTH_TOKEN must be configured.' };
  }
  try {
    logger.info(`[Twilio] ${label}`);
    const data = await fn(client);
    logger.info(`[Twilio] ${label} succeeded`);
    return { success: true, data };
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : undefined;
    logger.warn(`[Twilio] ${label} failed: ${describeError(err)}`, status ? { status } : undefined);
    return { success: false, error: describeError(err), status, code: err?.code };
  }
}

/* --------------------------------------------------------------------------
 * Access Tokens (mobile Voice SDK)
 * ------------------------------------------------------------------------ */

/**
 * Sign a short-lived Access Token with a VoiceGrant for a given user.
 * @param {string} userId
 * @param {{ ttl?: number, platform?: 'ios' | 'android' }} [opts]
 */
function createAccessToken(userId, opts = {}) {
  const { accountSid, apiKeySid, apiKeySecret, twimlAppSid } = getConfig();
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    return {
      success: false,
      error:
        'Twilio token signing requires TWILIO_AUTH_ID, TWILIO_API_SID, TWILIO_API_SECRET and TWILIO_TWIML_APP_SID.',
    };
  }

  const identity = clientIdentity(userId);
  const ttl = Number.isFinite(opts.ttl) ? opts.ttl : 3600;

  const pushCredentialSid =
    opts.platform === 'ios'
      ? getConfig().pushCredentialSidIos
      : opts.platform === 'android'
        ? getConfig().pushCredentialSidAndroid
        : '';

  const grant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
    ...(pushCredentialSid ? { pushCredentialSid } : {}),
  });

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity, ttl });
  token.addGrant(grant);

  return { success: true, token: token.toJwt(), identity, ttl };
}

/* --------------------------------------------------------------------------
 * TwiML generation
 * ------------------------------------------------------------------------ */

function statusCallbackUrl() {
  return buildWebhookUrl('/public/twilio/call-status');
}

function recordingCallbackUrl() {
  return buildWebhookUrl('/public/twilio/recording');
}

/**
 * Outbound TwiML — returned from the TwiML App Voice URL when the app places a
 * call via `voice.connect`. Dials the PSTN destination from the chosen caller id
 * and records the leg.
 * @param {{ to: string, callerId: string }} params
 */
function buildOutboundTwiml({ to, callerId }) {
  const response = new VoiceResponse();
  const destination = toDialE164(to);

  if (!destination || !validatePhone(destination)) {
    response.say('Sorry, that number could not be dialed. Please check the number and try again.');
    response.hangup();
    return response.toString();
  }

  const dialAttrs = {
    callerId: toE164(callerId) || getConfig().phoneNumber,
    record: 'record-from-answer-dual',
    answerOnBridge: true,
  };
  const recCb = recordingCallbackUrl();
  if (recCb) {
    dialAttrs.recordingStatusCallback = recCb;
    dialAttrs.recordingStatusCallbackEvent = 'completed';
    dialAttrs.recordingStatusCallbackMethod = 'POST';
  }

  const dial = response.dial(dialAttrs);
  const numberAttrs = {};
  const statusCb = statusCallbackUrl();
  if (statusCb) {
    numberAttrs.statusCallback = statusCb;
    numberAttrs.statusCallbackEvent = 'initiated ringing answered completed';
    numberAttrs.statusCallbackMethod = 'POST';
  }
  dial.number(numberAttrs, destination);

  return response.toString();
}

function addClientParameter(client, name, value) {
  if (value == null || value === '') return;
  client.parameter({ name, value: String(value) });
}

/**
 * Inbound TwiML — returned from a purchased number's Voice URL when a PSTN
 * caller dials it. Rings the resolved app user's Voice SDK client.
 * @param {{ identity: string, from?: string, to?: string, callSid?: string }} params
 */
function buildInboundToClientTwiml({ identity, from = '', to = '', callSid = '' }) {
  const response = new VoiceResponse();
  if (!identity) {
    response.say('Sorry, this number is not available right now.');
    response.hangup();
    return response.toString();
  }

  const dialAttrs = {
    record: 'record-from-answer-dual',
    answerOnBridge: true,
    timeout: 30,
  };
  const recCb = recordingCallbackUrl();
  if (recCb) {
    dialAttrs.recordingStatusCallback = recCb;
    dialAttrs.recordingStatusCallbackEvent = 'completed';
    dialAttrs.recordingStatusCallbackMethod = 'POST';
  }
  const statusCb = statusCallbackUrl();
  if (statusCb) {
    dialAttrs.action = statusCb;
    dialAttrs.method = 'POST';
  }

  const dial = response.dial(dialAttrs);
  const client = dial.client();
  client.identity(identity);
  addClientParameter(client, 'From', toE164(from) || from);
  addClientParameter(client, 'To', toE164(to) || to);
  addClientParameter(client, 'CallSid', callSid);

  return response.toString();
}

/** Graceful hangup TwiML for error paths on a Voice URL. */
function buildHangupTwiml(message = 'Unable to connect your call. Please try again.') {
  const response = new VoiceResponse();
  response.say(String(message));
  response.hangup();
  return response.toString();
}

/* --------------------------------------------------------------------------
 * Phone number management
 * ------------------------------------------------------------------------ */

/**
 * Search the Twilio catalogue for purchasable numbers.
 * @param {{
 *   country?: string,
 *   type?: string,
 *   areaCode?: number,
 *   contains?: string,
 *   inLocality?: string,
 *   inRegion?: string,
 *   inPostalCode?: string,
 *   nearNumber?: string,
 *   distance?: number,
 *   voiceEnabled?: boolean,
 *   smsEnabled?: boolean,
 *   mmsEnabled?: boolean,
 *   faxEnabled?: boolean,
 *   limit?: number,
 *   pageToken?: string,
 * }} params
 */
function extractPageToken(nextPageUrl) {
  if (!nextPageUrl) return null;
  try {
    const u = new URL(String(nextPageUrl));
    return u.searchParams.get('PageToken') || null;
  } catch {
    const m = String(nextPageUrl).match(/PageToken=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

async function searchAvailableNumbers(params = {}) {
  const country = (params.country || 'US').toUpperCase();
  const type = ['local', 'mobile', 'tollFree'].includes(params.type) ? params.type : 'local';
  const pageSize = Math.min(Number(params.limit) || 20, 30);

  const listParams = { pageSize };
  if (params.pageToken) listParams.pageToken = String(params.pageToken);
  if (params.areaCode) listParams.areaCode = Number(params.areaCode);
  if (params.contains) listParams.contains = String(params.contains).replace(/\D/g, '');
  if (params.inLocality) listParams.inLocality = String(params.inLocality).trim();
  if (params.inRegion) listParams.inRegion = String(params.inRegion).trim();
  if (params.inPostalCode) listParams.inPostalCode = String(params.inPostalCode).trim();
  if (params.nearNumber) listParams.nearNumber = toE164(params.nearNumber);
  if (params.distance != null && Number.isFinite(Number(params.distance))) {
    listParams.distance = Number(params.distance);
  }
  if (params.voiceEnabled === true) listParams.voiceEnabled = true;
  if (params.voiceEnabled === false) listParams.voiceEnabled = false;
  if (params.smsEnabled === true) listParams.smsEnabled = true;
  if (params.mmsEnabled === true) listParams.mmsEnabled = true;
  if (params.faxEnabled === true) listParams.faxEnabled = true;

  const result = await runTwilio(`GET AvailablePhoneNumbers/${country}/${type}`, (client) =>
    client.availablePhoneNumbers(country)[type].page(listParams),
  );
  if (!result.success) return result;

  const page = result.data;
  const instances = page?.instances ?? page?.data ?? [];
  const numbers = instances.map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality,
    region: n.region,
    isoCountry: n.isoCountry,
    capabilities: n.capabilities,
  }));
  const nextPageToken = extractPageToken(page?.nextPageUrl);

  return {
    success: true,
    numbers,
    nextPageToken,
    hasMore: Boolean(nextPageToken),
  };
}

/**
 * Account-specific monthly rental rates by number type (local, toll free, etc.).
 * Twilio owned-number list does not include price — use Pricing API.
 * @param {string} [countryIso]
 */
async function fetchPhoneNumberPricingByCountry(countryIso = 'US') {
  const iso = String(countryIso || 'US').toUpperCase();
  const result = await runTwilio(`GET Pricing PhoneNumbers/${iso}`, (client) =>
    client.pricing.v1.phoneNumbers.countries(iso).fetch(),
  );
  if (!result.success) return result;

  const rows = result.data?.phoneNumberPrices ?? result.data?.phone_number_prices ?? [];
  const rates = {};
  for (const row of rows) {
    const rawType = row.numberType ?? row.number_type ?? '';
    const key = String(rawType).toLowerCase().replace(/[\s_-]/g, '');
    const price = row.currentPrice ?? row.current_price ?? row.basePrice ?? row.base_price;
    if (key && price != null) rates[key] = String(price);
  }

  return {
    success: true,
    iso,
    priceUnit: result.data?.priceUnit ?? result.data?.price_unit ?? 'USD',
    rates,
  };
}

/**
 * Purchase a number and point its Voice URL at our inbound webhook.
 * @param {{ phoneNumber: string, friendlyName?: string }} params
 */
async function purchaseNumber(params = {}) {
  const phoneNumber = toE164(params.phoneNumber);
  if (!phoneNumber) {
    return { success: false, error: 'A valid phoneNumber (E.164) is required.' };
  }

  const createParams = { phoneNumber };
  const voiceUrl = buildWebhookUrl('/public/twilio/voice/inbound');
  if (voiceUrl) {
    createParams.voiceUrl = voiceUrl;
    createParams.voiceMethod = 'POST';
  }
  const statusCb = statusCallbackUrl();
  if (statusCb) {
    createParams.statusCallback = statusCb;
    createParams.statusCallbackMethod = 'POST';
  }
  if (params.friendlyName) createParams.friendlyName = String(params.friendlyName);

  const result = await runTwilio('POST IncomingPhoneNumbers (purchase)', (client) =>
    client.incomingPhoneNumbers.create(createParams),
  );
  if (!result.success) return result;

  const n = result.data;
  return {
    success: true,
    number: {
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      capabilities: n.capabilities,
      voiceUrl: n.voiceUrl,
      status: n.status,
    },
    providerResponse: n,
  };
}

/**
 * Release (delete) a purchased number from the Twilio account.
 * @param {string} sid - IncomingPhoneNumber SID (PN…)
 */
async function releaseNumber(sid) {
  if (!sid) return { success: false, error: 'Number sid is required.' };
  return runTwilio(`DELETE IncomingPhoneNumbers/${sid}`, (client) =>
    client.incomingPhoneNumbers(sid).remove(),
  );
}

/* --------------------------------------------------------------------------
 * Call REST helpers
 * ------------------------------------------------------------------------ */

/** Fetch a call resource by SID. */
async function fetchCall(callSid) {
  if (!callSid) return { success: false, error: 'callSid is required' };
  const result = await runTwilio(`GET Calls/${callSid}`, (client) => client.calls(callSid).fetch());
  if (!result.success) return result;
  return { success: true, data: result.data };
}

/** End (hang up) an in-progress call. */
async function endCall(callSid) {
  if (!callSid) return { success: false, error: 'callSid is required' };
  const result = await runTwilio(`POST Calls/${callSid} (completed)`, (client) =>
    client.calls(callSid).update({ status: 'completed' }),
  );
  if (!result.success) return result;
  return { success: true, callSid, status: 'completed', providerResponse: result.data };
}

/**
 * Toggle live recording on an in-progress call.
 * @param {string} callSid
 * @param {boolean} recording
 */
async function setRecording(callSid, recording) {
  if (!callSid) return { success: false, error: 'callSid is required' };
  if (recording) {
    return runTwilio(`POST Calls/${callSid}/Recordings`, (client) =>
      client.calls(callSid).recordings.create({
        recordingStatusCallback: recordingCallbackUrl() || undefined,
        recordingStatusCallbackEvent: ['completed'],
      }),
    );
  }
  // Stop the most recent in-progress recording.
  const list = await runTwilio(`GET Calls/${callSid}/Recordings`, (client) =>
    client.calls(callSid).recordings.list({ limit: 1 }),
  );
  if (!list.success) return list;
  const rec = list.data?.[0];
  if (!rec) return { success: true, stopped: false };
  return runTwilio(`POST Recordings/${rec.sid} (stopped)`, (client) =>
    client.calls(callSid).recordings(rec.sid).update({ status: 'stopped' }),
  );
}

/** Build a publicly playable recording URL (Twilio media is .mp3 on the URL + .mp3). */
function buildRecordingMediaUrl(recordingUrl) {
  if (!recordingUrl) return null;
  const url = String(recordingUrl);
  return url.endsWith('.mp3') || url.endsWith('.wav') ? url : `${url}.mp3`;
}

/**
 * Stream a Twilio recording's media bytes to an Express response.
 *
 * Twilio's recording media endpoint (api.twilio.com/.../Recordings/RE….mp3)
 * requires HTTP Basic Auth (Account SID + Auth Token). Opening that URL directly
 * in a browser yields a 401 + login prompt — which is what the app's
 * `Linking.openURL(recordingUrl)` was hitting. This proxies the request with the
 * account credentials so an already-authenticated app user can play the audio,
 * forwarding Range headers so the in-app player can seek.
 *
 * @param {string} recordingUrl - the stored Twilio media URL
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function proxyRecordingMedia(recordingUrl, req, res) {
  const { accountSid, authToken } = getConfig();
  if (!recordingUrl) {
    res.status(404).json({ success: false, message: 'No recording available.' });
    return Promise.resolve();
  }
  if (!accountSid || !authToken) {
    res.status(503).json({ success: false, message: 'Twilio credentials not configured.' });
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(String(recordingUrl));
    } catch {
      res.status(400).json({ success: false, message: 'Invalid recording URL.' });
      return resolve();
    }

    const transport = target.protocol === 'http:' ? http : https;
    const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    const headers = { Authorization: authHeader };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = transport.request(
      target,
      { method: 'GET', headers },
      (up) => {
        res.status(up.statusCode || 200);
        for (const name of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
          if (up.headers[name]) res.setHeader(name, up.headers[name]);
        }
        if (!up.headers['content-type']) res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', () => {
          if (!res.headersSent) res.status(502).end();
          resolve();
        });
      },
    );

    upstream.on('error', (err) => {
      logger.warn(`[Twilio] recording media proxy failed: ${describeError(err)}`);
      if (!res.headersSent) res.status(502).json({ success: false, message: 'Failed to fetch recording.' });
      resolve();
    });

    req.on('close', () => upstream.destroy());
    upstream.end();
  });
}

/* --------------------------------------------------------------------------
 * Conversational Intelligence (transcripts + AI summary)
 *
 * A Transcript is created against the configured Intelligence Service, pointing
 * at a finished call recording (source_sid = RE…). Twilio transcribes the audio
 * and runs the Service's attached Operators — including the generative
 * "Conversation Summary" operator. Results are read back via OperatorResults.
 * ------------------------------------------------------------------------ */

/** Whether Conversational Intelligence is configured (account creds + service). */
function isIntelligenceConfigured() {
  const { accountSid, authToken, intelligenceServiceSid } = getConfig();
  return Boolean(accountSid && authToken && intelligenceServiceSid);
}

function intelligenceWebhookUrl() {
  return buildWebhookUrl('/webhooks/twilio-intelligence');
}

/**
 * Create a Transcript for a finished recording.
 * @param {{ recordingSid: string, callSid?: string }} params
 */
async function createTranscript(params = {}) {
  const { intelligenceServiceSid } = getConfig();
  if (!intelligenceServiceSid) {
    return { success: false, error: 'TWILIO_INTELLIGENCE_SERVICE_SID is not configured.' };
  }
  const recordingSid = params.recordingSid ? String(params.recordingSid) : '';
  if (!recordingSid) return { success: false, error: 'recordingSid is required' };

  const createParams = {
    serviceSid: intelligenceServiceSid,
    channel: {
      // Dual-channel recordings map participant_channel 1/2 → the two legs.
      media_properties: { source_sid: recordingSid },
    },
  };
  // Tie the transcript back to the call so the completion webhook can resolve it
  // without a Recording→Call lookup.
  if (params.callSid) createParams.customerKey = String(params.callSid);

  const result = await runTwilio('POST Intelligence Transcripts', (client) =>
    client.intelligence.v2.transcripts.create(createParams),
  );
  if (!result.success) return result;
  return { success: true, sid: result.data?.sid, status: result.data?.status, data: result.data };
}

/** Fetch a Transcript resource (status lives here). */
async function fetchTranscript(transcriptSid) {
  if (!transcriptSid) return { success: false, error: 'transcriptSid is required' };
  return runTwilio(`GET Intelligence Transcripts/${transcriptSid}`, (client) =>
    client.intelligence.v2.transcripts(String(transcriptSid)).fetch(),
  );
}

/** Pull the summary text out of a generative operator result, shape-tolerant. */
function extractSummaryText(operatorResults = []) {
  for (const op of operatorResults) {
    const gen = op?.textGenerationResults ?? op?.text_generation_results;
    if (!gen) continue;
    const text =
      (typeof gen === 'string' && gen) ||
      gen.result ||
      gen.text ||
      gen.summary ||
      (Array.isArray(gen.results) ? gen.results.join('\n') : '');
    if (text && String(text).trim()) return String(text).trim();
  }
  return '';
}

/**
 * Rebuild a readable transcript from the per-sentence results.
 * @param {Array<{ mediaChannel?: number, transcript?: string }>} sentences
 */
function buildTranscriptText(sentences = []) {
  return sentences
    .map((s) => {
      const speaker = s.mediaChannel === 2 ? 'B' : 'A';
      const text = (s.transcript || '').trim();
      return text ? `${speaker}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Fetch the finished results for a transcript: status, AI summary, and the
 * reconstructed transcript text. Only reads operator/sentence sub-resources
 * once the transcript has reached `completed`.
 * @param {string} transcriptSid
 */
async function fetchTranscriptResults(transcriptSid) {
  const head = await fetchTranscript(transcriptSid);
  if (!head.success) return head;

  const status = head.data?.status || 'unknown';
  if (status !== 'completed') {
    return { success: true, status, summary: '', transcript: '', pending: status !== 'failed' };
  }

  const [opResult, sentenceResult] = await Promise.all([
    runTwilio(`GET Intelligence Transcripts/${transcriptSid}/OperatorResults`, (client) =>
      client.intelligence.v2.transcripts(String(transcriptSid)).operatorResults.list({ limit: 50 }),
    ),
    runTwilio(`GET Intelligence Transcripts/${transcriptSid}/Sentences`, (client) =>
      client.intelligence.v2.transcripts(String(transcriptSid)).sentences.list({ limit: 1000 }),
    ),
  ]);

  const summary = opResult.success ? extractSummaryText(opResult.data || []) : '';
  const transcript = sentenceResult.success ? buildTranscriptText(sentenceResult.data || []) : '';

  return { success: true, status, summary, transcript, pending: false };
}

/* --------------------------------------------------------------------------
 * Webhook signature validation
 * ------------------------------------------------------------------------ */

function shouldVerifyWebhooks() {
  if (config.twilio.verifyWebhooks === false) return false;
  if (config.twilio.verifyWebhooks === true) return true;
  return config.env === 'production';
}

/**
 * Validate an incoming Twilio webhook signature.
 * @param {string} signature - X-Twilio-Signature header
 * @param {string} url - the full public URL Twilio requested
 * @param {Record<string, unknown>} params - the POST body params
 */
function validateSignature(signature, url, params = {}) {
  const { authToken } = getConfig();
  if (!authToken || !signature) return false;
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch (err) {
    logger.warn(`[Twilio] Signature validation error: ${describeError(err)}`);
    return false;
  }
}

/* --------------------------------------------------------------------------
 * Bridge click-to-call + caller ID enforcement (ATS parity with Plivo)
 * ------------------------------------------------------------------------ */

function isE164(num) {
  return /^\+[1-9]\d{7,14}$/.test(String(num || '').trim());
}

/** HMAC for bridge-answer webhook — defense-in-depth alongside Twilio signature. */
function bridgeCallSignature(toNumber, callerId) {
  return crypto
    .createHmac('sha256', config.jwt.secret)
    .update(`${toNumber}|${callerId}`)
    .digest('hex');
}

function verifyBridgeCallSignature(toNumber, callerId, sig) {
  const expected = bridgeCallSignature(toNumber, callerId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function buildBridgeAnswerTwiml({ to, callerId }) {
  return buildOutboundTwiml({ to, callerId });
}

/**
 * Resolve Voice SDK identity for inbound PSTN. Uses CompanyPhoneNumber.assignedTo
 * when mapped; falls back to TWILIO_INBOUND_DEFAULT_USER for legacy single-user routing.
 * @param {string} [calledNumber] E.164 or Twilio To value
 * @returns {Promise<string>} client identity (user_<mongoId>) or ''
 */
async function resolveInboundIdentity(calledNumber = '') {
  const { resolveInboundUserIdForCalledNumber } = await import('./companyPhoneNumber.service.js');
  const userId = await resolveInboundUserIdForCalledNumber(calledNumber);
  return userId ? clientIdentity(userId) : '';
}

/**
 * List purchased Incoming Phone Numbers on the Twilio account (account-wide ownership).
 * @param {{ limit?: number, offset?: number }} params
 */
async function listIncomingNumbers({ limit, offset } = {}) {
  const pageLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const pageOffset = Math.max(0, Number(offset) || 0);
  const result = await runTwilio('GET IncomingPhoneNumbers', (client) =>
    client.incomingPhoneNumbers.list({ limit: pageLimit + pageOffset }),
  );
  if (!result.success) return result;

  const all = (result.data || []).slice(pageOffset, pageOffset + pageLimit);
  const numbers = all.map((n) => ({
    sid: n.sid,
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    capabilities: n.capabilities,
    voiceUrl: n.voiceUrl,
    status: n.status,
    isoCountry: n.isoCountry || 'US',
    dateCreated: n.dateCreated,
    origin: n.origin,
  }));
  return { success: true, numbers, total: numbers.length, offset: pageOffset, limit: pageLimit };
}

/**
 * Fetch call recordings by Twilio CallSid (Bolna telephony_data.provider_call_id).
 * @param {string} callSid
 */
async function getCallRecordings(callSid) {
  if (!callSid) return { success: false, error: 'callSid is required.' };
  const result = await runTwilio(`GET Calls/${callSid}/Recordings`, (client) =>
    client.calls(String(callSid).trim()).recordings.list({ limit: 20 }),
  );
  if (!result.success) return result;
  const { accountSid } = getConfig();
  const recordings = (result.data || []).map((r) => {
    const mediaUrl =
      r.sid && accountSid
        ? `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${r.sid}.mp3`
        : buildRecordingMediaUrl(r.uri ? `https://api.twilio.com${String(r.uri).replace('.json', '')}` : '');
    return {
      recordingId: r.sid,
      callUuid: callSid,
      recordingUrl: mediaUrl,
      durationMs: Number(r.duration) ? Number(r.duration) * 1000 : null,
      type: 'dual',
      addTime: r.dateCreated,
    };
  });
  return { success: true, recordings };
}

/**
 * Caller ID must be an owned Twilio number or a verified outgoing caller ID.
 * @param {string} callerId
 */
async function validateCallerId(callerId) {
  const e164 = toE164(callerId);
  if (!e164 || !validatePhone(e164)) {
    return { valid: false, error: 'callerId must be a valid E.164 number.' };
  }

  const owned = await listIncomingNumbers({ limit: 50 });
  if (owned.success) {
    const onAccount = (owned.numbers || []).some(
      (n) => toE164(n.phoneNumber) === e164 && n.capabilities?.voice !== false,
    );
    if (onAccount) return { valid: true, callerId: e164 };
  }

  const verified = await runTwilio('GET OutgoingCallerIds', (client) =>
    client.outgoingCallerIds.list({ phoneNumber: e164, limit: 1 }),
  );
  if (verified.success && verified.data?.length) {
    return { valid: true, callerId: e164 };
  }

  const fallback = toE164(getConfig().phoneNumber);
  if (fallback && fallback === e164) {
    return { valid: true, callerId: e164 };
  }

  return {
    valid: false,
    error: 'callerId is not a phone number owned or verified on this Twilio account.',
  };
}

/**
 * Click-to-call bridge: ring agentPhone, then dial toNumber with callerId on answer.
 * @param {{ agentPhone: string, toNumber: string, callerId: string }} params
 */
async function placeBridgeCall({ agentPhone, toNumber, callerId } = {}) {
  const agent = toDialE164(agentPhone);
  const dest = toDialE164(toNumber);
  const from = toE164(callerId);

  if (!isE164(agent)) {
    return { success: false, error: 'agentPhone must be E.164 (e.g. +14155550100).' };
  }
  if (!isE164(dest)) {
    return { success: false, error: 'toNumber must be E.164 (e.g. +14155550100).' };
  }
  if (!isE164(from)) {
    return { success: false, error: 'callerId (your bought number) must be E.164.' };
  }

  const callerCheck = await validateCallerId(from);
  if (!callerCheck.valid) {
    return { success: false, error: callerCheck.error };
  }

  const base = getWebhookBaseUrl();
  if (/localhost|127\.0\.0\.1|\b0\.0\.0\.0\b/.test(base)) {
    return {
      success: false,
      error:
        'Call answer URL is not publicly reachable. Set TWILIO_WEBHOOK_BASE_URL (or BACKEND_PUBLIC_URL) to a public https URL so Twilio can fetch bridge TwiML.',
    };
  }

  const sig = bridgeCallSignature(dest, from);
  const bridgePath = `/public/twilio/bridge-answer?to=${encodeURIComponent(dest)}&callerId=${encodeURIComponent(from)}&sig=${sig}`;
  const bridgeUrl = buildWebhookUrl(bridgePath);
  if (!bridgeUrl) {
    return { success: false, error: 'TWILIO_WEBHOOK_BASE_URL is not configured.' };
  }

  const statusCb = statusCallbackUrl();
  const createParams = {
    to: agent,
    from,
    url: bridgeUrl,
    method: 'POST',
  };
  if (statusCb) {
    createParams.statusCallback = statusCb;
    createParams.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
    createParams.statusCallbackMethod = 'POST';
  }

  const result = await runTwilio('POST Calls (bridge)', (client) => client.calls.create(createParams));
  if (!result.success) return result;

  return {
    success: true,
    requestUuid: result.data?.sid,
    message: 'Call initiated — your phone will ring.',
    providerResponse: result.data,
  };
}

export default {
  clientIdentity,
  userIdFromClient,
  isConfigured,
  toE164,
  toDialE164,
  buildWebhookUrl,
  getWebhookBaseUrl,
  normalizeWebhookBaseUrl,
  createAccessToken,
  buildOutboundTwiml,
  buildInboundToClientTwiml,
  buildHangupTwiml,
  searchAvailableNumbers,
  fetchPhoneNumberPricingByCountry,
  purchaseNumber,
  releaseNumber,
  fetchCall,
  endCall,
  setRecording,
  buildRecordingMediaUrl,
  proxyRecordingMedia,
  isIntelligenceConfigured,
  intelligenceWebhookUrl,
  createTranscript,
  fetchTranscript,
  fetchTranscriptResults,
  shouldVerifyWebhooks,
  validateSignature,
  statusCallbackUrl,
  recordingCallbackUrl,
  getConfig,
  bridgeCallSignature,
  verifyBridgeCallSignature,
  buildBridgeAnswerTwiml,
  resolveInboundIdentity,
  listIncomingNumbers,
  getCallRecordings,
  validateCallerId,
  placeBridgeCall,
};
