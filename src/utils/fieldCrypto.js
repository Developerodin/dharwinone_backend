import crypto from 'node:crypto';

/**
 * AES-256-GCM for single sensitive field values (bank account number, SSN, Aadhaar,
 * PAN, UAN). Deliberately NOT a mongoose plugin: the service layer encrypts and
 * decrypts explicitly, so a `.lean()` read returns the stored ciphertext rather than
 * silently handing a caller plaintext it did not ask for.
 *
 * Storage format: "v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>".
 *
 * Policy: single key from a single env var. No rotation, no KMS, no per-record key.
 * The "v1" prefix is the entire upgrade path — when rotation is needed, add a "v2"
 * branch in decryptField that reads PAYROLL_ENCRYPTION_KEY_V2, start writing v2, and
 * backfill v1 rows in the background. Do not add that machinery before it is needed.
 *
 * Ceiling: encryption is non-deterministic, so these fields cannot be queried or
 * uniquely indexed. That is intentional — there is no lookup-by-account-number use
 * case. If one ever appears it needs a blind index (HMAC of the value), not a
 * deterministic cipher.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_HEX_LENGTH = 64;

/**
 * Read the key per call rather than at module load. config.js runs dotenv with
 * `override: true` and the test suite patches config rather than process.env, so a
 * module-load read would break every importer under test.
 */
const getKey = () => {
  const hex = process.env.PAYROLL_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('PAYROLL_ENCRYPTION_KEY is not set — payroll fields cannot be encrypted or read');
  }
  if (hex.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('PAYROLL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
};

export const encryptField = (plaintext) => {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
};

export const decryptField = (stored) => {
  if (typeof stored !== 'string') throw new Error('Cannot decrypt a non-string value');
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('Cannot decrypt: malformed stored value');
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) throw new Error(`Cannot decrypt: unknown version prefix "${version}"`);
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // GCM auth failure means the ciphertext or tag was altered, or the key changed.
    // Surface it — never fall back to returning the raw stored string.
    throw new Error('Cannot decrypt: authentication failed (tampered value or wrong key)');
  }
};

export const isEncrypted = (value) =>
  typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4;

/** Plaintext tail kept alongside the ciphertext so list views never decrypt. */
export const last4 = (plaintext) => {
  if (plaintext === null || plaintext === undefined) return '';
  const s = String(plaintext);
  return s.length <= 4 ? s : s.slice(-4);
};
