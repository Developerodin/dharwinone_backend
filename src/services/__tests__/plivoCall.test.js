/**
 * Guards the Plivo click-to-call security path: the HMAC that stops the public
 * answer-XML endpoint from being abused to dial arbitrary numbers, plus the
 * bridge XML shape. Run: node --test src/services/__tests__/plivoCall.test.js
 *
 * Env is set before the dynamic import so config validation passes without a
 * real .env (config throws otherwise).
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import plivo from 'plivo';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/dharwin-test';
process.env.JWT_SECRET = 'test_secret_at_least_32_chars_long_xx';
process.env.PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'TEST_PLIVO_AUTH';
process.env.PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'test_plivo_auth_token_secret';

const TO = '+14155550100';
const CALLER = '+14155550199';
const goodSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${TO}|${CALLER}`).digest('hex');

// Loaded after env is set so config validation passes without a real .env.
let plivoService;
before(async () => {
  ({ default: plivoService } = await import('../plivo.service.js'));
});

test('verifyCallSignature accepts a correctly signed pair', () => {
  assert.equal(plivoService.verifyCallSignature(TO, CALLER, goodSig), true);
});

test('verifyCallSignature rejects a tampered destination (toll-fraud guard)', () => {
  assert.equal(plivoService.verifyCallSignature('+19998887777', CALLER, goodSig), false);
});

test('verifyCallSignature rejects empty / wrong-length sig without throwing', () => {
  assert.equal(plivoService.verifyCallSignature(TO, CALLER, ''), false);
  assert.equal(plivoService.verifyCallSignature(TO, CALLER, 'abc'), false);
});

test('bridgeAnswerXml dials the target with the bought caller ID', () => {
  const xml = plivoService.bridgeAnswerXml({ toNumber: TO, callerId: CALLER });
  assert.match(xml, /<Dial callerId="\+14155550199"><Number>\+14155550100<\/Number><\/Dial>/);
});

test('placeBridgeCall rejects non-E.164 input before hitting Plivo', async () => {
  const r = await plivoService.placeBridgeCall({ agentPhone: '12345', toNumber: TO, callerId: CALLER });
  assert.equal(r.success, false);
});

test('sdkAnswerXml restores a stripped "+" and dials with the caller ID', async () => {
  // Browser SDK may pass the number without "+".
  const xml = await plivoService.sdkAnswerXml({ to: '14155550100', callerId: '14155550199' });
  assert.match(xml, /<Dial callerId="\+14155550199"><Number>\+14155550100<\/Number><\/Dial>/);
});

test('sdkAnswerXml accepts Plivo SIP URI To values from browser-SDK webhooks', async () => {
  const xml = await plivoService.sdkAnswerXml({
    to: '918755887760@phone.plivo.com',
    callerId: '18336990430',
  });
  assert.match(xml, /<Dial callerId="\+18336990430"><Number>\+918755887760<\/Number><\/Dial>/);
});

test('sdkAnswerXml returns null on a non-numeric destination', async () => {
  assert.equal(await plivoService.sdkAnswerXml({ to: 'abc', callerId: CALLER }), null);
});

test('sdkAnswerXml uses registered browser call intent when callerId header is missing', async () => {
  const r = await plivoService.registerBrowserCallIntent({
    toNumber: '+918755887760',
    callerId: '+18336990430',
  });
  assert.equal(r.success, true);
  assert.ok(r.intent);
  const xml = await plivoService.sdkAnswerXml({
    to: '918755887760@phone.plivo.com',
    callerId: '',
  });
  assert.match(xml, /<Dial callerId="\+18336990430"><Number>\+918755887760<\/Number><\/Dial>/);
});

test('sdkAnswerXml resolves caller ID from X-PH-intent token without store', async () => {
  const r = await plivoService.registerBrowserCallIntent({
    toNumber: '+918755887760',
    callerId: '+18336990430',
  });
  const xml = await plivoService.sdkAnswerXml({
    to: '918755887760@phone.plivo.com',
    callerId: '',
    intentToken: r.intent,
  });
  assert.match(xml, /<Dial callerId="\+18336990430"><Number>\+918755887760<\/Number><\/Dial>/);
});

test('sdkAnswerXml browser call intent is cleared after successful dial', async () => {
  await plivoService.registerBrowserCallIntent({
    toNumber: '+918755887760',
    callerId: '+18336990430',
  });
  await plivoService.sdkAnswerXml({ to: '+918755887760', callerId: '' });
  await plivoService.clearBrowserCallIntent('+918755887760');
  assert.equal(await plivoService.sdkAnswerXml({ to: '+918755887760', callerId: '' }), null);
});

test('webrtcAnswerUrlWithIntent embeds the HMAC token in the path', () => {
  const intent = 'destsig';
  const url = plivoService.webrtcAnswerUrlWithIntent(intent);
  assert.match(url, /\/v1\/public\/plivo\/sdk-answer\/i\//);
  assert.ok(url.endsWith(`/i/${encodeURIComponent(intent)}`));
});

test('isArmedWebrtcAnswerUrl detects intent path and legacy query on sdk-answer', () => {
  assert.equal(plivoService.isArmedWebrtcAnswerUrl('https://x/v1/public/plivo/sdk-answer/i/abc'), true);
  assert.equal(plivoService.isArmedWebrtcAnswerUrl('https://x/v1/public/plivo/sdk-answer?intent=abc'), true);
  assert.equal(plivoService.isArmedWebrtcAnswerUrl('https://x/v1/public/plivo/sdk-answer'), false);
});

test('sdkAnswerXml browser call intent survives failed webhook then succeeds', async () => {
  await plivoService.registerBrowserCallIntent({
    toNumber: '+918755887760',
    callerId: '+18336990430',
  });
  assert.equal(await plivoService.sdkAnswerXml({ to: '', callerId: '' }), null);
  const xml = await plivoService.sdkAnswerXml({ to: '+918755887760', callerId: '' });
  assert.match(xml, /<Dial callerId="\+18336990430"><Number>\+918755887760<\/Number><\/Dial>/);
});

test('enrichAccessTokenForBrowserSdk mirrors grants.voice into per.voice for browser SDK', () => {
  const raw = new plivo.AccessToken(
    process.env.PLIVO_AUTH_ID,
    process.env.PLIVO_AUTH_TOKEN,
    'endpoint-user',
    { lifetime: 3600 },
    'trace-uid'
  );
  raw.addVoiceGrants(false, true);
  const enriched = plivoService.enrichAccessTokenForBrowserSdk(raw.toJwt());
  const payload = JSON.parse(Buffer.from(enriched.split('.')[1], 'base64url').toString());
  assert.equal(payload.grants.voice.outgoing_allow, true);
  assert.deepEqual(payload.per.voice, payload.grants.voice);
});
