/**
 * Diagnostic 2 — Test refresh token against Microsoft (run locally; uses .env secrets).
 *
 *   node scripts/test-outlook-refresh-token.mjs [accountId]
 *
 * Reads refresh_token from emailaccounts by id (default: argv[2] or env OUTLOOK_TEST_ACCOUNT_ID).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const accountId = process.argv[2] || process.env.OUTLOOK_TEST_ACCOUNT_ID;
if (!accountId) {
  console.error('Usage: node scripts/test-outlook-refresh-token.mjs <accountObjectId>');
  process.exit(1);
}

const clientId = (process.env.MICROSOFT_CLIENT_ID || '').trim();
const clientSecret = (process.env.MICROSOFT_CLIENT_SECRET || '').trim();
const tenant = (process.env.MICROSOFT_TENANT_ID || 'common').trim() || 'common';

if (!clientId || !clientSecret) {
  console.error('MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET required in .env');
  process.exit(1);
}

const emailAccountSchema = new mongoose.Schema({}, { collection: 'emailaccounts', strict: false });
const EmailAccount = mongoose.model('DiagEmail', emailAccountSchema);

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);
  const doc = await EmailAccount.findById(accountId).select('refreshToken provider').lean();
  await mongoose.disconnect();

  if (!doc || doc.provider !== 'outlook') {
    console.error('Account not found or not outlook:', accountId);
    process.exit(1);
  }
  const rt = (doc.refreshToken || '').trim();
  if (!rt) {
    console.error('No refresh_token in DB for this account.');
    process.exit(1);
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: rt,
    scope: 'offline_access Mail.ReadWrite Mail.Send User.Read',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  if (json.access_token) {
    console.log(JSON.stringify({ ok: true, status: res.status, expires_in: json.expires_in, token_type: json.token_type }, null, 2));
  } else {
    console.log(JSON.stringify({ ok: false, status: res.status, ...json }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
