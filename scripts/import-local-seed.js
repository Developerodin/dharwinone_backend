/**
 * Import uat-dharwin.roles.json and uat-dharwin.users.json into local MongoDB.
 * Usage: node scripts/import-local-seed.js [path-to-roles.json] [path-to-users.json]
 * If paths omitted, uses the WhatsApp transfers folder paths below.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const DEFAULT_ROLES_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'Local',
  'Packages',
  '5319275A.WhatsAppDesktop_cv1g1gvanyjgm',
  'LocalState',
  'sessions',
  '93AD7B52AC23E707C6E9B26D4594591BFA292FD8',
  'transfers',
  '2026-06',
  'uat-dharwin.roles.json'
);
const DEFAULT_USERS_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'Local',
  'Packages',
  '5319275A.WhatsAppDesktop_cv1g1gvanyjgm',
  'LocalState',
  'sessions',
  '93AD7B52AC23E707C6E9B26D4594591BFA292FD8',
  'transfers',
  '2026-06',
  'uat-dharwin.users.json'
);

function convertExtendedJson(obj) {
  if (Array.isArray(obj)) return obj.map(convertExtendedJson);
  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '$oid') return new mongoose.Types.ObjectId(obj.$oid);
    if (keys.length === 1 && keys[0] === '$date') return new Date(obj.$date);
    const out = {};
    for (const k of keys) out[k] = convertExtendedJson(obj[k]);
    return out;
  }
  return obj;
}

async function importCollection(conn, name, filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`);
    return 0;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const arr = JSON.parse(raw);
  const docs = arr.map((doc) => convertExtendedJson(doc));
  const { db } = conn;
  const coll = db.collection(name);
  await coll.deleteMany({});
  if (docs.length > 0) {
    await coll.insertMany(docs);
  }
  console.log(`  ${name}: ${docs.length} document(s) imported`);
  return docs.length;
}

async function main() {
  const rolesPath = process.argv[2] || DEFAULT_ROLES_PATH;
  const usersPath = process.argv[3] || DEFAULT_USERS_PATH;

  let mongoUrl = process.env.MONGODB_URL;
  if (!mongoUrl) {
    console.error('MONGODB_URL is not set in .env');
    process.exit(1);
  }

  // Target uat-dharwin database (replace existing db name in URL or append)
  const match = mongoUrl.match(/^(mongodb(\+srv)?:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/);
  if (match) {
    mongoUrl = `${match[1]}/uat-dharwin${match[4] || ''}`;
  }

  console.log('Connecting to MongoDB (database: uat-dharwin)...');
  await mongoose.connect(mongoUrl, {});
  console.log('Connected. Importing...');

  try {
    const conn = mongoose.connection;
    await importCollection(conn, 'roles', rolesPath);
    await importCollection(conn, 'users', usersPath);
    console.log('Import completed.');
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
