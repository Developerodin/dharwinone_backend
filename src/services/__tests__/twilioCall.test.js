/**
 * Twilio telephony guards: TwiML shape, bridge HMAC, E.164 normalization, signature validation.
 * Run: node --test src/services/__tests__/twilioCall.test.js
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/dharwin-test';
process.env.JWT_SECRET = 'test_secret_at_least_32_chars_long_xx';
process.env.TELEPHONY_PROVIDER = 'twilio';
process.env.TWILIO_AUTH_ID = 'ACtest_account_sid_1234567890';
process.env.TWILIO_AUTH_TOKEN = 'test_twilio_auth_token_secret';
process.env.TWILIO_API_SID = 'SKtest_api_key_sid_1234567890';
process.env.TWILIO_API_SECRET = 'test_twilio_api_secret_value';
process.env.TWILIO_TWIML_APP_SID = 'APtest_twiml_app_sid_1234567890';
process.env.TWILIO_WEBHOOK_BASE_URL = 'https://apis.example.com';

const TO = '+14155550100';
const CALLER = '+14155550199';

let twilioService;

before(async () => {
  ({ default: twilioService } = await import('../twilio.service.js'));
});

test('toDialE164 normalizes 10-digit India national to +91', () => {
  assert.equal(twilioService.toDialE164('8290918154'), '+918290918154');
});

test('buildOutboundTwiml dials destination with callerId and recording callback', () => {
  const xml = twilioService.buildOutboundTwiml({ to: TO, callerId: CALLER });
  assert.match(xml, /<Dial[^>]*callerId="\+14155550199"/);
  assert.match(xml, /<Number[^>]*>\+14155550100<\/Number>/);
  assert.match(xml, /record="record-from-answer-dual"/);
  assert.match(xml, /recordingStatusCallback/);
});

test('verifyBridgeCallSignature accepts valid HMAC', () => {
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${TO}|${CALLER}`).digest('hex');
  assert.equal(twilioService.verifyBridgeCallSignature(TO, CALLER, sig), true);
});

test('verifyBridgeCallSignature rejects tampered destination', () => {
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${TO}|${CALLER}`).digest('hex');
  assert.equal(twilioService.verifyBridgeCallSignature('+19998887777', CALLER, sig), false);
});

test('buildBridgeAnswerTwiml matches outbound dial shape', () => {
  const xml = twilioService.buildBridgeAnswerTwiml({ to: TO, callerId: CALLER });
  assert.match(xml, /<Dial[^>]*callerId="\+14155550199"/);
  assert.match(xml, /<Number[^>]*>\+14155550100<\/Number>/);
});

test('validateSignature accepts Twilio-signed webhook', async () => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const url = 'https://apis.example.com/v1/public/twilio/call-status';
  const params = { CallSid: 'CA123', CallStatus: 'completed' };
  const twilioMod = await import('twilio');
  const signature = twilioMod.default.getExpectedTwilioSignature(authToken, url, params);
  assert.equal(twilioService.validateSignature(signature, url, params), true);
});

test('placeBridgeCall rejects invalid agentPhone before REST', async () => {
  const r = await twilioService.placeBridgeCall({ agentPhone: '12345', toNumber: TO, callerId: CALLER });
  assert.equal(r.success, false);
});

test('createAccessToken returns identity for Voice SDK', () => {
  const uid = '507f1f77bcf86cd799439011';
  const r = twilioService.createAccessToken(uid);
  assert.equal(r.success, true);
  assert.ok(r.token);
  assert.equal(r.identity, `user_${uid}`);
});

test('resolveInboundIdentity returns empty when no default user configured', () => {
  assert.equal(twilioService.resolveInboundIdentity(), '');
});

test('buildInboundToClientTwiml rings the resolved client', () => {
  const xml = twilioService.buildInboundToClientTwiml({ identity: 'user_507f1f77bcf86cd799439011' });
  assert.match(xml, /<Client>user_507f1f77bcf86cd799439011<\/Client>/);
  assert.match(xml, /record="record-from-answer-dual"/);
});

test('webhook URLs use /v1/public/twilio paths', () => {
  assert.match(twilioService.statusCallbackUrl(), /\/v1\/public\/twilio\/call-status$/);
  assert.match(twilioService.recordingCallbackUrl(), /\/v1\/public\/twilio\/recording$/);
});
