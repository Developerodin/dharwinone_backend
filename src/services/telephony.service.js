/**
 * Provider-neutral telephony facade — routes to Plivo or Twilio based on
 * `config.telephony.provider` (`TELEPHONY_PROVIDER` env).
 */

import config from '../config/config.js';
import plivoService from './plivo.service.js';
import twilioService from './twilio.service.js';
import numberPricingService from './numberPricing.service.js';
import { computeRequiresVerification, regulationRequiresVerification } from '../utils/numberRegulatory.util.js';
import crypto from 'crypto';

function provider() {
  return config.telephony?.provider === 'twilio' ? 'twilio' : 'plivo';
}

function isTwilio() {
  return provider() === 'twilio';
}

// Twilio returns capability keys inconsistently cased (voice / SMS / MMS / fax).
// Read case-insensitively so SMS/MMS aren't silently dropped.
function hasCapability(caps, key) {
  if (!caps) return false;
  const k = key.toLowerCase();
  for (const [name, val] of Object.entries(caps)) {
    if (name.toLowerCase() === k) return Boolean(val);
  }
  return false;
}

function mapTwilioSearchNumber(n) {
  return {
    number: String(n.phoneNumber || '').replace(/^\+/, ''),
    phoneNumber: n.phoneNumber || '',
    type: 'local',
    region: n.region || '',
    city: n.locality || '',
    country: n.isoCountry || '',
    monthlyRentalRate: null,
    twilioMonthlyRate: null,
    retailMonthlyPrice: null,
    retailPrice: null,
    currency: 'USD',
    setupRate: null,
    voiceEnabled: hasCapability(n.capabilities, 'voice'),
    smsEnabled: hasCapability(n.capabilities, 'sms'),
    mmsEnabled: hasCapability(n.capabilities, 'mms'),
    voiceRate: null,
    smsRate: null,
    restriction: '',
    restrictionText: '',
    addressRequirements: n.addressRequirements ?? null,
    requiresVerification: false,
    requiresBundle: false,
    beta: Boolean(n.beta),
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
    voiceEnabled: n.capabilities ? hasCapability(n.capabilities, 'voice') : true,
    smsEnabled: hasCapability(n.capabilities, 'sms'),
    mmsEnabled: hasCapability(n.capabilities, 'mms'),
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
    // Geographic filters (locality/region/postal/near/distance) only apply to Local
    // numbers in Twilio; toll-free and mobile are non-geographic and silently ignore
    // them — omit so the result set isn't misleading.
    const geo =
      twilioType === 'local'
        ? {
            inLocality: params.city?.trim() || undefined,
            inRegion: params.region?.trim() || undefined,
            inPostalCode: params.postalCode?.trim() || undefined,
            nearNumber: params.nearNumber?.trim() || undefined,
            distance: params.distance,
          }
        : {};

    const result = await twilioService.searchAvailableNumbers({
      country,
      type: twilioType,
      limit: params.limit,
      pageToken: params.pageToken,
      ...geo,
      ...patternBits,
      ...caps,
    });
    if (!result.success) return result;

    const pricing = await twilioService.fetchPhoneNumberPricingByCountry(country);
    const rates = pricing.success ? pricing.rates : {};
    const typeKey = twilioType === 'tollFree' ? 'tollfree' : twilioType.toLowerCase();
    const monthly = rates[typeKey];

    const regResult = await twilioService.fetchRegulationsForCountryType(country, typeKey);
    const regulations = regResult.regulations || [];

    const retail = await numberPricingService.resolveRetailPrice({
      countryIso: country,
      numberType: typeKey,
    });

    const numbers = (result.numbers || []).map((n) => {
      const mapped = mapTwilioSearchNumber(n);
      // Twilio's search response carries no type; results are all the searched type.
      mapped.type = typeKey;
      if (monthly != null) {
        mapped.monthlyRentalRate = monthly;
        mapped.twilioMonthlyRate = monthly;
      }
      mapped.retailMonthlyPrice = retail.monthlyPriceUsd;
      mapped.retailPrice = retail.monthlyPriceUsd;
      mapped.currency = retail.currency;
      const requiresVerification = computeRequiresVerification({
        addressRequirements: mapped.addressRequirements,
        regulations,
      });
      mapped.requiresVerification = requiresVerification;
      mapped.requiresBundle = requiresVerification;
      return mapped;
    });

    const countryRequiresVerification =
      regulationRequiresVerification(regulations) ||
      numbers.some((n) => n.requiresVerification);

    return {
      success: true,
      numbers,
      hasMore: Boolean(result.hasMore),
      nextPageToken: result.nextPageToken || undefined,
      offset: Number(params.offset) || 0,
      limit: Number(params.limit) || 20,
      total: undefined,
      provider: 'twilio',
      requiresVerification: countryRequiresVerification,
      requiresBundle: countryRequiresVerification,
      retailMonthlyPrice: retail.monthlyPriceUsd,
      currency: retail.currency,
    };
  }
  const plivoResult = await plivoService.searchAvailableNumbers(params);
  if (plivoResult.success) {
    return { ...plivoResult, provider: 'plivo' };
  }
  return plivoResult;
}

/**
 * Dynamic country list from Twilio + retail/regulatory metadata for the app picker.
 */
async function listAvailableCountries() {
  if (!isTwilio()) {
    return {
      success: false,
      error: 'Country catalogue is only available when TELEPHONY_PROVIDER=twilio.',
    };
  }

  const result = await twilioService.listAvailableCountries();
  if (!result.success) return result;

  await numberPricingService.ensureDefaultPricing();
  const pricingRows = await numberPricingService.listPricingConfigs({ includeInactive: false });

  const countries = await Promise.all(
    (result.countries || []).map(async (c) => {
      const iso = c.countryCode;
      const retail = numberPricingService.resolveRetailPriceFromRows(pricingRows, {
        countryIso: iso,
        numberType: 'local',
      });
      const regResult = await twilioService.fetchRegulationsForCountryType(iso, 'local');
      const requiresVerification = regulationRequiresVerification(regResult.regulations || []);
      return {
        countryCode: iso,
        country: c.country,
        beta: Boolean(c.beta),
        requiresVerification,
        requiresBundle: requiresVerification,
        retailMonthlyPrice: retail.monthlyPriceUsd,
        currency: retail.currency,
        // From Twilio AvailablePhoneNumbers country subresource_uris (local/mobile/tollFree).
        numberTypes: Array.isArray(c.numberTypes) && c.numberTypes.length
          ? c.numberTypes
          : ['local', 'mobile', 'tollfree'],
      };
    }),
  );

  return {
    success: true,
    countries,
    cached: Boolean(result.cached),
    provider: 'twilio',
  };
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

// Live recording toggle on an in-progress call (Twilio REST). Plivo browser
// calls aren't on the connected account the same way, so it's Twilio-only.
async function setRecording({ callSid, recording } = {}) {
  if (isTwilio()) return twilioService.setRecording(callSid, Boolean(recording));
  return { success: false, error: 'Live recording is only supported on Twilio.' };
}

async function endCall({ callSid } = {}) {
  if (isTwilio()) return twilioService.endCall(callSid);
  return { success: false, error: 'endCall is only supported on Twilio.' };
}

async function mintBrowserToken({ uid, platform } = {}) {
  if (isTwilio()) {
    const opts =
      platform === 'ios' || platform === 'android' ? { platform } : {};
    const result = twilioService.createAccessToken(String(uid || ''), opts);
    if (!result.success) return result;
    const identity = result.identity;
    return {
      success: true,
      token: result.token,
      username: identity,
      identity,
      ttl: result.ttl,
      provider: 'twilio',
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
  listAvailableCountries,
  buyNumber,
  listOwnedNumbers,
  placeBridgeCall,
  setRecording,
  endCall,
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
