/**
 * Clean local uat-dharwin database and import from DB/ folder.
 * Run from backend: npm run clean:import  or  node scripts/clean-and-import-db.js
 * Requires: MongoDB running at 127.0.0.1:27017, DB folder at Dharwin/DB/
 */
/* eslint-disable no-console */

import { MongoClient, ObjectId } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '../../DB');
const URI = 'mongodb://127.0.0.1:27017';

async function run() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db('uat-dharwin');
  console.log('Connected.');

  // 1. Drop all collections (clean)
  const collections = await db.listCollections().toArray();
  for (const c of collections) {
    await db.collection(c.name).drop();
    console.log('  Dropped:', c.name);
  }
  if (collections.length === 0) {
    console.log('  (Database was already empty)');
  }
  console.log('Database cleaned.\n');

  // 2. Import roles first (users reference roleIds)
  const rolesPath = path.join(DB_DIR, 'uat-dharwin.roles.json');
  if (fs.existsSync(rolesPath)) {
    const raw = fs.readFileSync(rolesPath, 'utf8');
    const docs = JSON.parse(raw);
    const roles = docs.map(convertExtJson);
    if (roles.length > 0) {
      await db.collection('roles').insertMany(roles);
      console.log('Imported roles:', roles.length);
    }
  } else {
    console.log('Skipped roles (file not found:', rolesPath, ')');
  }

  // 3. Import users
  const usersPath = path.join(DB_DIR, 'uat-dharwin.users.json');
  if (fs.existsSync(usersPath)) {
    const raw = fs.readFileSync(usersPath, 'utf8');
    const docs = JSON.parse(raw);
    const users = docs.map(convertExtJson);
    if (users.length > 0) {
      await db.collection('users').insertMany(users);
      console.log('Imported users:', users.length);
    }
  } else {
    console.log('Skipped users (file not found:', usersPath, ')');
  }

  console.log('\nDone. Local DB refreshed from DB/ folder.');
  await client.close();
  process.exit(0);
}

function convertExtJson(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.$oid) out[k] = new ObjectId(v.$oid);
      else if (v.$date) out[k] = new Date(v.$date);
      else out[k] = convertExtJson(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => (x && x.$oid ? new ObjectId(x.$oid) : convertExtJson(x)));
    } else {
      out[k] = v;
    }
  }
  return out;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
