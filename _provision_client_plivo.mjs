// One-shot Plivo provisioning for a NEW (client) account.
// Mirrors ensureWebrtcApp() + closes the number->app binding gap the backend
// doesn't handle. Idempotent: safe to re-run.
//
// Usage (PowerShell):
//   $env:PLIVO_AUTH_ID="<client auth id>"; $env:PLIVO_AUTH_TOKEN="<client token>"; `
//   $env:ANSWER_BASE="https://backend-jz9i.onrender.com"; node _provision_client_plivo.mjs
//
// Usage (bash):
//   PLIVO_AUTH_ID=<id> PLIVO_AUTH_TOKEN=<tok> ANSWER_BASE=https://backend-jz9i.onrender.com node _provision_client_plivo.mjs

import 'dotenv/config'; // loads .env from this dir — just edit .env, no need to export vars

const A = process.env.PLIVO_AUTH_ID?.trim();
const T = process.env.PLIVO_AUTH_TOKEN?.trim();
const BASE = (process.env.ANSWER_BASE || 'https://backend-jz9i.onrender.com').replace(/\/$/, '');
const ANSWER_URL = `${BASE}/v1/public/plivo/sdk-answer`;

// Must match src/services/plivo.service.js
const APP_NAME = 'dharwin-webrtc-dialer';
const EP_ALIAS = 'dharwin-webrtc-dialer';
const EP_PREFIX = 'dharwinweb';

if (!A || !T) { console.error('Set PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN env vars.'); process.exit(1); }

const auth = 'Basic ' + Buffer.from(`${A}:${T}`).toString('base64');
const api = `https://api.plivo.com/v1/Account/${A}`;
const pick = (o, ...k) => k.map((x) => o?.[x]).find((v) => v != null);
const items = (j) => (Array.isArray(j) ? j : j?.objects || []);

async function call(method, path, body) {
  const r = await fetch(api + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return json;
}

(async () => {
  console.log(`Provisioning account ${A}`);
  console.log(`answer_url = ${ANSWER_URL}\n`);

  // 1. Application
  let apps = items(await call('GET', '/Application/'));
  let app = apps.find((a) => pick(a, 'app_name', 'appName') === APP_NAME);
  if (!app) {
    app = await call('POST', '/Application/', { app_name: APP_NAME, answer_url: ANSWER_URL, answer_method: 'POST' });
    console.log(`+ created Application ${APP_NAME} (${app.app_id})`);
  } else {
    const cur = pick(app, 'answer_url', 'answerUrl');
    if (cur !== ANSWER_URL) {
      await call('POST', `/Application/${pick(app, 'app_id', 'appId')}/`, { answer_url: ANSWER_URL, answer_method: 'POST' });
      console.log(`~ updated Application answer_url (${pick(app, 'app_id', 'appId')})`);
    } else console.log(`= Application ${APP_NAME} ok (${pick(app, 'app_id', 'appId')})`);
  }
  const appId = String(pick(app, 'app_id', 'appId'));

  // 2. Endpoint
  let eps = items(await call('GET', '/Endpoint/'));
  let ep = eps.find((e) => pick(e, 'alias') === EP_ALIAS);
  if (!ep) {
    const username = EP_PREFIX + Math.random().toString().slice(2, 12) + Math.random().toString().slice(2, 12);
    const password = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    ep = await call('POST', '/Endpoint/', { username, password, alias: EP_ALIAS, app_id: appId });
    console.log(`+ created Endpoint ${ep.username}`);
  } else {
    const epId = pick(ep, 'endpoint_id', 'endpointId');
    if (!String(pick(ep, 'application') || '').includes(appId)) {
      await call('POST', `/Endpoint/${epId}/`, { app_id: appId });
      console.log(`~ re-bound Endpoint -> app ${appId}`);
    } else console.log(`= Endpoint ${pick(ep, 'username')} ok`);
  }

  // 3. Bind every voice-enabled number to the app (the gap the backend skips)
  const nums = items(await call('GET', '/Number/'));
  console.log(`\nNumbers (${nums.length}):`);
  for (const n of nums) {
    const number = n.number;
    const voice = pick(n, 'voice_enabled', 'voiceEnabled');
    const boundApp = String(n.application || '');
    if (voice === false) { console.log(`  - ${number} skip (not voice-enabled)`); continue; }
    if (boundApp.includes(appId)) { console.log(`  = ${number} already on app`); continue; }
    await call('POST', `/Number/${number}/`, { app_id: appId });
    console.log(`  ~ ${number} bound -> app ${appId}`);
  }

  console.log(`\nDone. App ${appId} | answer_url ${ANSWER_URL}`);
  console.log('Set PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN on Render to this account, then redeploy.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
