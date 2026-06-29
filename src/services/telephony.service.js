/**
 * Provider-neutral telephony facade — routes to Plivo or Twilio based on
 * `config.telephony.provider` (`TELEPHONY_PROVIDER` env).
 */

import config from '../config/config.js';
import plivoService from './plivo.service.js';
import twilioService from './twilio.service.js';
import crypto from 'crypto';

function provider() {
  return config.telephony?.provider === 'twilio' ? 'twilio' : 'plivo';
}

function isTwilio() {
  return provider() === 'twilio';
}

function mapTwilioSearchNumber(n) {
  return {
    number: String(n.phoneNumber || '').replace(/^\+/, ''),
    type: 'local',
    region: n.region || '',
    city: n.locality || '',
    country: n.isoCountry || '',
    monthlyRentalRate: null,
    setupRate: null,
    voiceEnabled: Boolean(n.capabilities?.voice),
    smsEnabled: Boolean(n.capabilities?.sms),
    mmsEnabled: Boolean(n.capabilities?.mms),
    voiceRate: null,
    smsRate: null,
    restriction: '',
    restrictionText: '',
  };
}

function inferTwilioNumberType(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  // US toll-free NPAs: 800, 888, 877, 866, 855, 844, 833
  if (digits.length === 11 && digits.startsWith('1')) {
    const npa = digits.slice(1, 4);
    if (['800', '888', '877', '866', '855', '844', '833'].includes(npa)) return 'tollfree';
  }
  return 'local';
}

function mapTwilioOwnedNumber(n) {
  const digits = String(n.phoneNumber || '').replace(/^\+/, '');
  const iso = n.isoCountry || 'US';
  const regionLabel = iso === 'US' ? 'United States' : iso;
  return {
    sid: n.sid || '',
    number: digits,
    alias: n.friendlyName || '',
    type: inferTwilioNumberType(n.phoneNumber),
    region: regionLabel,
    country: iso,
    addedOn: n.dateCreated ? new Date(n.dateCreated).toISOString() : '',
    application: n.voiceUrl || '',
    monthlyRentalRate: null,
    voiceEnabled: n.capabilities?.voice !== false,
    smsEnabled: Boolean(n.capabilities?.sms),
    mmsEnabled: Boolean(n.capabilities?.mms),
    carrier: 'twilio',
  };
}

/** Map Plivo-style pattern to Twilio areaCode (3 digits) or contains. */
function resolveTwilioPattern(pattern) {
  const digits = String(pattern || '').replace(/\D/g, '');
  if (/^\d{3}$/.test(digits)) return { areaCode: Number(digits) };
  if (digits.length > 0) return { contains: digits };
  return {};
}

/** Parse services=voice,sms,mms into Twilio capability flags. */
function resolveTwilioCapabilities(services) {
  const parts = String(services || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) {
    return { voiceEnabled: true };
  }
  const caps = {};
  if (parts.includes('voice')) caps.voiceEnabled = true;
  if (parts.includes('sms')) caps.smsEnabled = true;
  if (parts.includes('mms')) caps.mmsEnabled = true;
  if (parts.includes('fax')) caps.faxEnabled = true;
  return caps;
}

async function searchAvailableNumbers(params = {}) {
  if (isTwilio()) {
    const country = params.countryIso || params.country || 'US';
    const typeMap = { tollfree: 'tollFree', mobile: 'mobile', local: 'local' };
    const twilioType = typeMap[String(params.type || '').toLowerCase()] || 'local';
    const patternBits = resolveTwilioPattern(params.pattern);
    const caps = resolveTwilioCapabilities(params.services);

    const result = await twilioService.searchAvailableNumbers({
      country,
      type: twilioType,
      limit: params.limit,
      pageToken: params.pageToken,
      inLocality: params.city?.trim() || undefined,
      inRegion: params.region?.trim() || undefined,
      inPostalCode: params.postalCode?.trim() || undefined,
      nearNumber: params.nearNumber?.trim() || undefined,
      distance: params.distance,
      ...patternBits,
      ...caps,
    });
    if (!result.success) return result;

    const pricing = await twilioService.fetchPhoneNumberPricingByCountry(country);
    const rates = pricing.success ? pricing.rates : {};
    const typeKey = twilioType === 'tollFree' ? 'tollfree' : twilioType.toLowerCase();
    const monthly = rates[typeKey];

    const numbers = (result.numbers || []).map((n) => {
      const mapped = mapTwilioSearchNumber(n);
      if (monthly != null) mapped.monthlyRentalRate = monthly;
      return mapped;
    });

    return {
      success: true,
      numbers,
      hasMore: Boolean(result.hasMore),
      nextPageToken: result.nextPageToken || undefined,
      offset: Number(params.offset) || 0,
      limit: Number(params.limit) || 20,
      total: undefined,
      provider: 'twilio',
    };
  }
  const plivoResult = await plivoService.searchAvailableNumbers(params);
  if (plivoResult.success) {
    return { ...plivoResult, provider: 'plivo' };
  }
  return plivoResult;
}

async function buyNumber(number) {
  if (isTwilio()) {
    const result = await twilioService.purchaseNumber({ phoneNumber: number });
    if (!result.success) return result;
    const purchased = result.number?.phoneNumber || number;
    const e164 = purchased.startsWith('+') ? purchased : `+${String(purchased).replace(/\D/g, '')}`;
    return {
      success: true,
      number: String(purchased).replace(/^\+/, ''),
      phoneNumberE164: e164,
      message: 'Number purchased successfully.',
      providerSid: result.number?.sid || '',
      friendlyName: result.number?.friendlyName || e164,
      capabilities: result.number?.capabilities,
    };
  }
  return plivoService.buyNumber(number);
}

async function listOwnedNumbers(params = {}) {
  if (isTwilio()) {
    const result = await twilioService.listIncomingNumbers(params);
    if (!result.success) return result;

    const raw = result.numbers || [];
    const countries = [...new Set(raw.map((n) => String(n.isoCountry || 'US').toUpperCase()))];
    const pricingByCountry = {};
    for (const iso of countries) {
      const pr = await twilioService.fetchPhoneNumberPricingByCountry(iso);
      if (pr.success) pricingByCountry[iso] = pr.rates;
    }

    const numbers = raw.map((n) => {
      const mapped = mapTwilioOwnedNumber(n);
      const iso = String(n.isoCountry || 'US').toUpperCase();
      const typeKey = inferTwilioNumberType(n.phoneNumber);
      const rate = pricingByCountry[iso]?.[typeKey];
      if (rate != null) mapped.monthlyRentalRate = rate;
      return mapped;
    });

    return { success: true, numbers, total: result.total ?? numbers.length };
  }
  return plivoService.listOwnedNumbers(params);
}

async function placeBridgeCall(params = {}) {
  if (isTwilio()) {
    return twilioService.placeBridgeCall(params);
  }
  return plivoService.placeBridgeCall(params);
}

async function mintBrowserToken({ uid } = {}) {
  if (isTwilio()) {
    const result = twilioService.createAccessToken(String(uid || ''));
    if (!result.success) return result;
    const identity = result.identity;
    return {
      success: true,
      token: result.token,
      username: identity,
      identity,
    };
  }
  const result = await plivoService.mintWebrtcToken({ uid });
  if (!result.success) return result;
  return {
    success: true,
    token: result.token,
    username: result.username,
    identity: result.username,
  };
}

function bridgeWebhookResponse({ toNumber, callerId }) {
  if (isTwilio()) {
    return twilioService.buildBridgeAnswerTwiml({ to: toNumber, callerId });
  }
  return plivoService.bridgeAnswerXml({ toNumber, callerId });
}

async function getCallRecordings(providerCallId) {
  if (isTwilio()) {
    return twilioService.getCallRecordings(providerCallId);
  }
  return plivoService.getCallRecordings(providerCallId);
}

async function validateCallerId(callerId) {
  if (isTwilio()) {
    return twilioService.validateCallerId(callerId);
  }
  const e164 = String(callerId || '').trim();
  if (!e164.startsWith('+')) {
    return { valid: false, error: 'callerId must be E.164.' };
  }
  const owned = await plivoService.listOwnedNumbers({ limit: 50 });
  if (!owned.success) {
    return { valid: false, error: owned.error || 'Failed to verify caller ID.' };
  }
  const match = (owned.numbers || []).some(
    (n) => {
      const num = String(n.number || '').trim();
      const normalized = num.startsWith('+') ? num : `+${num}`;
      return normalized === e164 && n.voiceEnabled;
    },
  );
  if (match) return { valid: true, callerId: e164 };
  return { valid: false, error: 'callerId is not a phone number owned by this account.' };
}

function verifyBridgeCallSignature(toNumber, callerId, sig) {
  if (isTwilio()) {
    return twilioService.verifyBridgeCallSignature(toNumber, callerId, sig);
  }
  return plivoService.verifyCallSignature(toNumber, callerId, sig);
}

function bridgeCallSignature(toNumber, callerId) {
  if (isTwilio()) {
    return twilioService.bridgeCallSignature(toNumber, callerId);
  }
  return crypto
    .createHmac('sha256', config.jwt.secret)
    .update(`${toNumber}|${callerId}`)
    .digest('hex');
}

async function registerBrowserCallIntent(params = {}) {
  if (isTwilio()) {
    return {
      success: false,
      error: 'Browser call intents are not used with Twilio — pass CallerId via Device.connect params.',
    };
  }
  return plivoService.registerBrowserCallIntent(params);
}

async function sdkAnswerXml(params = {}) {
  if (isTwilio()) {
    return null;
  }
  return plivoService.sdkAnswerXml(params);
}

function getProviderName() {
  return provider();
}

function isConfigured() {
  if (isTwilio()) {
    return twilioService.isConfigured();
  }
  return Boolean(config.plivo?.authId && config.plivo?.authToken);
}

export default {
  getProviderName,
  isConfigured,
  isTwilio,
  searchAvailableNumbers,
  buyNumber,
  listOwnedNumbers,
  placeBridgeCall,
  mintBrowserToken,
  bridgeWebhookResponse,
  getCallRecordings,
  validateCallerId,
  verifyBridgeCallSignature,
  bridgeCallSignature,
  registerBrowserCallIntent,
  sdkAnswerXml,
  // Plivo-only helpers still exposed for public Plivo webhooks
  verifyCallSignature: plivoService.verifyCallSignature,
  bridgeAnswerXml: plivoService.bridgeAnswerXml,
};
