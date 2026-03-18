/**
 * Usage: node scripts/check-email-account.mjs <accountId>
 * Example: node scripts/check-email-account.mjs 69b93bf548e4c6efc36f9b25
 *
 * Reports whether the EmailAccount exists and if it likely needs reconnect
 * (no refresh token = cannot refresh; often means pre-offline_access connect).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const accountId = process.argv[2];
if (!accountId) {
  console.error('Usage: node scripts/check-email-account.mjs <accountId>');
  process.exit(1);
}

const emailAccountSchema = new mongoose.Schema(
  {
    user: mongoose.Schema.Types.ObjectId,
    provider: String,
    email: String,
    accessToken: String,
    refreshToken: String,
    tokenExpiry: Date,
    status: String,
  },
  { collection: 'emailaccounts', strict: false }
);
const EmailAccount = mongoose.model('EmailAccountCheck', emailAccountSchema);

async function main() {
  const url = process.env.MONGODB_URL;
  if (!url) {
    console.error('MONGODB_URL missing in .env');
    process.exit(1);
  }
  await mongoose.connect(url);
  const doc = await EmailAccount.findById(accountId).lean();
  if (!doc) {
    console.log(JSON.stringify({ exists: false, accountId }, null, 2));
    await mongoose.disconnect();
    process.exit(0);
  }
  const rt = doc.refreshToken;
  const hasRt = Boolean(rt && String(rt).trim().length > 0);
  const diagnosis = !hasRt
    ? 'No refresh token stored — reconnect Outlook (likely connected before offline_access or MSAL cache fix).'
    : hasRt && doc.tokenExpiry && new Date(doc.tokenExpiry) > new Date()
      ? 'Has refresh token and access token not expired yet.'
      : 'Has refresh token; if mail fails, token refresh or Graph consent may still be wrong — try reconnect.';

  console.log(
    JSON.stringify(
      {
        exists: true,
        accountId: doc._id?.toString(),
        provider: doc.provider,
        email: doc.email,
        status: doc.status,
        hasRefreshToken: hasRt,
        refreshTokenLength: hasRt ? String(rt).length : 0,
        tokenExpiry: doc.tokenExpiry || null,
        userId: doc.user?.toString?.() || doc.user,
        createdAt: doc.createdAt || null,
        diagnosis,
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
