/**
 * Non-destructive cloud (Atlas) -> local Mongo sync via timestamp-aware upsert merge.
 * Never drops collections or uses mongorestore --drop.
 *
 *   node scripts/mirror-cloud-to-local.js                       # upsert sync, then verify
 *   node scripts/mirror-cloud-to-local.js --dry-run               # preview upsert actions (no writes)
 *   node scripts/mirror-cloud-to-local.js --verify-only [--fast]  # read-only comparison
 *   node scripts/mirror-cloud-to-local.js --selftest              # unit checks (no DB)
 *
 * Optional upsert flags:
 *   node scripts/mirror-cloud-to-local.js --no-backup             # skip pre-upsert local mongodump
 *   node scripts/mirror-cloud-to-local.js --collections=users,employees
 *   node scripts/mirror-cloud-to-local.js --delete-local-only     # prune stale local-only docs
 *
 * Conflict resolution (matched by _id):
 *   Each document's "freshness" is the first parseable timestamp among (in order):
 *     updatedAt, modifiedAt, createdAt, lastModified
 *   - local timestamp > cloud timestamp  -> skip (keep local; counted as skipped-newer-local)
 *   - cloud timestamp >= local timestamp -> cloud wins (replaceOne upsert)
 *   - either side missing a timestamp    -> cloud wins (same as cloud >= local)
 *   Local-only docs are never deleted when their timestamp is newer than the cloud
 *   collection's max timestamp (--delete-local-only respects this rule).
 *   With --delete-local-only, stale local-only docs are pruned before cloud upserts
 *   to avoid unique-index conflicts when a local-only doc shares a compound key with
 *   an incoming cloud doc but a different _id.
 *
 * Backup (before upsert writes):
 *   mongodump dumps the local db to backups/mirror-local-YYYY-MM-DD-HHmmss/ (or MIRROR_BACKUP_DIR).
 *   Skipped for --dry-run. Pass --no-backup to skip (dev speed). backups/ is gitignored.
 *
 * Required env (script exits before connecting if missing or disabled):
 *   MIRROR_CLOUD_TO_LOCAL_ENABLED=true   # literal true only; no CLI bypass
 *   CLOUD_MONGODB_URL                    # Atlas/cloud source (read-only; secondaryPreferred)
 *   LOCAL_MONGODB_URL                    # local target (must be private/loopback unless --force)
 *
 * Requires: mongodump on PATH for pre-upsert backup (MongoDB Database Tools).
 *           Upsert sync uses the Node mongodb driver.
 *
 * Exit code 0 only when local matches cloud collection-for-collection (after sync or verify-only).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

export const MIRROR_ENABLE_ENV = 'MIRROR_CLOUD_TO_LOCAL_ENABLED';

const SYSTEM_COLLECTION = /^system\./;
const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
const DEFAULT_EXCLUDED = new Set(['sessions']);
const UPSERT_BATCH_SIZE = 500;
/** First match wins when comparing document freshness (see header). */
export const TIMESTAMP_FIELDS = ['updatedAt', 'modifiedAt', 'createdAt', 'lastModified'];
const TIMESTAMP_PROJECTION = Object.fromEntries(TIMESTAMP_FIELDS.map((f) => [f, 1]));

export const isMirrorEnabled = () => String(process.env[MIRROR_ENABLE_ENV] ?? '').toLowerCase() === 'true';

export const requireMirrorEnabled = () => {
  if (!isMirrorEnabled()) {
    throw new Error(
      `${MIRROR_ENABLE_ENV}=true is required to run this script. Set it in .env when you intentionally want to sync cloud -> local. There is no CLI bypass.`
    );
  }
};

export const requireEnvUri = (name) => {
  const uri = process.env[name];
  if (!uri) throw new Error(`${name} is required (.env) — no fallback to MONGODB_URL or MONGO_URI`);
  return uri;
};

export const dbNameOf = (uri) => decodeURIComponent(new URL(uri).pathname.replace(/^\//, ''));
export const stripDb = (uri) => {
  const u = new URL(uri);
  u.pathname = '/';
  return u.toString();
};
export const mask = (uri) => uri.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
export const nsArgs = (fromDb, toDb) => (fromDb === toDb ? [] : ['--nsFrom', `${fromDb}.*`, '--nsTo', `${toDb}.*`]);
export const withParams = (uri, params) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
};
export const isSafeTarget = (uri) => {
  const host = new URL(uri).hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || PRIVATE_HOST.test(host);
};

export const validateUri = (uri, label) => {
  if (!URL.canParse(uri)) {
    throw new Error(`${label} is not a valid MongoDB URI: ${mask(uri)}`);
  }
  const db = dbNameOf(uri);
  if (!db) throw new Error(`${label} must include a database name: ${mask(uri)}`);
  return db;
};

export const shouldSkipCollection = (name, excluded = DEFAULT_EXCLUDED) =>
  SYSTEM_COLLECTION.test(name) || excluded.has(name);

export const parseCollectionsArg = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const toTimestampMs = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
};

export const getDocTimestamp = (doc) => {
  if (!doc || typeof doc !== 'object') return null;
  for (const field of TIMESTAMP_FIELDS) {
    const ms = toTimestampMs(doc[field]);
    if (ms != null) return ms;
  }
  return null;
};

export const maxTimestamp = (a, b) => {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
};

export const shouldSkipCloudOverwrite = (cloudDoc, localDoc) => {
  const cloudTs = getDocTimestamp(cloudDoc);
  const localTs = getDocTimestamp(localDoc);
  return localTs != null && cloudTs != null && localTs > cloudTs;
};

export const shouldSkipLocalDelete = (localDoc, cloudMaxTs) => {
  const localTs = getDocTimestamp(localDoc);
  if (localTs == null) return false;
  if (cloudMaxTs == null) return true;
  return localTs > cloudMaxTs;
};

export const classifyCloudDoc = (cloudDoc, localDoc) => {
  if (!localDoc) return 'insert';
  if (shouldSkipCloudOverwrite(cloudDoc, localDoc)) return 'skip-newer-local';
  return 'update';
};

export const backupDirName = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `mirror-local-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const REMOVED_FLAGS = new Set(['--yes', '--archive', '--from-archive', '--local', '--upsert']);

const parseArgs = (argv) => {
  const out = {
    verifyOnly: false,
    fast: false,
    force: false,
    selftest: false,
    dryRun: false,
    deleteLocalOnly: false,
    noBackup: false,
    collections: [],
    jobs: Math.max(2, Math.min(8, os.cpus().length)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (REMOVED_FLAGS.has(a)) {
      throw new Error(
        `${a} is no longer supported — this script only performs non-destructive upsert merge (see header comment)`
      );
    }
    if (a === '--verify-only') out.verifyOnly = true;
    else if (a === '--fast') out.fast = true;
    else if (a === '--force') out.force = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--delete-local-only') out.deleteLocalOnly = true;
    else if (a === '--no-backup') out.noBackup = true;
    else if (a === '--jobs' && argv[i + 1]) out.jobs = Number(argv[(i += 1)]);
    else if (a.startsWith('--collections=')) out.collections = parseCollectionsArg(a.slice('--collections='.length));
    else if (a === '--collections' && argv[i + 1]) out.collections = parseCollectionsArg(argv[(i += 1)]);
    else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  if (!Number.isInteger(out.jobs) || out.jobs < 1) throw new Error('--jobs must be a positive integer');
  if (out.dryRun && out.verifyOnly) throw new Error('--dry-run and --verify-only are mutually exclusive');
  return out;
};

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) throw new Error(`${cmd} failed to start (is it on PATH?): ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`);
};

export const dumpLocalBackup = (localUri, localDb, backupRoot = 'backups') => {
  const dir = path.join(backupRoot, backupDirName());
  fs.mkdirSync(dir, { recursive: true });
  run('mongodump', ['--uri', localUri, '--db', localDb, '--out', dir]);
  return dir;
};

const requireTools = (names) => {
  for (const name of names) {
    const res = spawnSync(name, ['--version'], { stdio: 'ignore' });
    if (res.error || res.status !== 0) {
      throw new Error(
        `${name} not usable on PATH - install MongoDB Database Tools (e.g. sudo yum install -y mongodb-database-tools)`
      );
    }
  }
};

const snapshot = async (uri, dbName, { fast = false, timeoutMs = 10000 } = {}) => {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: timeoutMs });
  try {
    const db = client.db(dbName);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !SYSTEM_COLLECTION.test(n))
      .sort();
    const out = new Map();
    for (const name of names) {
      const coll = db.collection(name);
      const [count, indexes] = await Promise.all([
        fast ? coll.estimatedDocumentCount() : coll.countDocuments(),
        coll.indexes(),
      ]);
      out.set(name, { count, indexes: indexes.length });
    }
    return out;
  } finally {
    await client.close();
  }
};

export const report = (cloud, local) => {
  const names = [...new Set([...cloud.keys(), ...local.keys()])].sort();
  const rows = names.map((name) => {
    const c = cloud.get(name) ?? null;
    const l = local.get(name) ?? null;
    let status = 'OK';
    if (c === null) status = 'EXTRA-LOCAL';
    else if (l === null) status = 'MISSING-LOCAL';
    else if (c.count !== l.count) status = 'COUNT-MISMATCH';
    else if (c.indexes !== l.indexes) status = 'INDEX-MISMATCH';
    return { name, c, l, status };
  });

  const pad = Math.max(10, ...rows.map((r) => r.name.length));
  const cell = (v) => String(v ?? '-').padStart(9);
  console.log(`\n${'collection'.padEnd(pad)}  ${'cloud'.padStart(9)}  ${'local'.padStart(9)}  ${'idx'.padStart(7)}  status`);
  console.log('-'.repeat(pad + 45));
  for (const r of rows) {
    const idx = `${r.c ? r.c.indexes : '-'}/${r.l ? r.l.indexes : '-'}`;
    console.log(
      `${r.name.padEnd(pad)}  ${cell(r.c?.count)}  ${cell(r.l?.count)}  ${idx.padStart(7)}  ${
        r.status === 'OK' ? '' : r.status
      }`
    );
  }

  const bad = rows.filter((r) => r.status !== 'OK');
  const sum = (m) => [...m.values()].reduce((a, b) => a + b.count, 0);
  console.log(
    `\ncollections: cloud ${cloud.size} / local ${local.size}   documents: cloud ${sum(cloud)} / local ${sum(local)}`
  );
  if (bad.length === 0) {
    console.log('VERIFY OK - every cloud collection is present locally with the same document and index count.');
    return true;
  }
  console.log(`VERIFY FAILED - ${bad.length} problem collection(s): ${bad.map((r) => `${r.name}[${r.status}]`).join(', ')}`);
  return false;
};

const emptyUpsertStats = () => ({
  cloudDocs: 0,
  wouldInsert: 0,
  wouldUpdate: 0,
  wouldSkipNewerLocal: 0,
  inserted: 0,
  updated: 0,
  skippedNewerLocal: 0,
  wouldDeleteLocalOnly: 0,
  wouldSkipDeleteNewerLocal: 0,
  deletedLocalOnly: 0,
  skippedDeleteNewerLocal: 0,
});

export const upsertBatch = async (localColl, docs, { dryRun = false } = {}) => {
  const stats = emptyUpsertStats();
  if (docs.length === 0) return stats;

  stats.cloudDocs = docs.length;
  const ids = docs.map((d) => d._id);
  const existing = await localColl
    .find({ _id: { $in: ids } }, { projection: { _id: 1, ...TIMESTAMP_PROJECTION } })
    .toArray();
  const existingById = new Map(existing.map((e) => [String(e._id), e]));

  const toWrite = [];
  for (const doc of docs) {
    const action = classifyCloudDoc(doc, existingById.get(String(doc._id)));
    if (action === 'insert') {
      if (dryRun) stats.wouldInsert += 1;
      else toWrite.push(doc);
    } else if (action === 'update') {
      if (dryRun) stats.wouldUpdate += 1;
      else toWrite.push(doc);
    } else if (dryRun) stats.wouldSkipNewerLocal += 1;
    else stats.skippedNewerLocal += 1;
  }

  if (dryRun || toWrite.length === 0) return stats;

  const ops = toWrite.map((doc) => ({
    replaceOne: {
      filter: { _id: doc._id },
      replacement: doc,
      upsert: true,
    },
  }));
  const result = await localColl.bulkWrite(ops, { ordered: false });
  stats.inserted = result.upsertedCount;
  stats.updated = result.matchedCount;
  return stats;
};

const mergeUpsertStats = (total, part) => {
  total.cloudDocs += part.cloudDocs;
  total.wouldInsert += part.wouldInsert;
  total.wouldUpdate += part.wouldUpdate;
  total.wouldSkipNewerLocal += part.wouldSkipNewerLocal;
  total.inserted += part.inserted;
  total.updated += part.updated;
  total.skippedNewerLocal += part.skippedNewerLocal;
  total.wouldDeleteLocalOnly += part.wouldDeleteLocalOnly;
  total.wouldSkipDeleteNewerLocal += part.wouldSkipDeleteNewerLocal;
  total.deletedLocalOnly += part.deletedLocalOnly;
  total.skippedDeleteNewerLocal += part.skippedDeleteNewerLocal;
  return total;
};

const pruneLocalOnlyDocs = async (localColl, cloudIds, cloudMaxTs, stats, { dryRun = false } = {}) => {
  let deleteBatch = [];
  for await (const doc of localColl.find({}, { projection: { _id: 1, ...TIMESTAMP_PROJECTION } })) {
    if (cloudIds.has(String(doc._id))) continue;
    if (shouldSkipLocalDelete(doc, cloudMaxTs)) {
      if (dryRun) stats.wouldSkipDeleteNewerLocal += 1;
      else stats.skippedDeleteNewerLocal += 1;
      continue;
    }
    deleteBatch.push(doc._id);
    if (deleteBatch.length >= UPSERT_BATCH_SIZE) {
      if (dryRun) stats.wouldDeleteLocalOnly += deleteBatch.length;
      else {
        const res = await localColl.deleteMany({ _id: { $in: deleteBatch } });
        stats.deletedLocalOnly += res.deletedCount;
      }
      deleteBatch = [];
    }
  }
  if (deleteBatch.length > 0) {
    if (dryRun) stats.wouldDeleteLocalOnly += deleteBatch.length;
    else {
      const res = await localColl.deleteMany({ _id: { $in: deleteBatch } });
      stats.deletedLocalOnly += res.deletedCount;
    }
  }
};

export const syncCollectionUpsert = async (cloudColl, localColl, { dryRun = false, deleteLocalOnly = false } = {}) => {
  const stats = emptyUpsertStats();

  if (deleteLocalOnly) {
    const cloudIds = new Set();
    let cloudMaxTs = null;
    for await (const doc of cloudColl.find({}, { projection: { _id: 1, ...TIMESTAMP_PROJECTION } })) {
      cloudMaxTs = maxTimestamp(cloudMaxTs, getDocTimestamp(doc));
      cloudIds.add(String(doc._id));
    }
    await pruneLocalOnlyDocs(localColl, cloudIds, cloudMaxTs, stats, { dryRun });
  }

  let batch = [];
  for await (const doc of cloudColl.find({})) {
    batch.push(doc);
    if (batch.length >= UPSERT_BATCH_SIZE) {
      mergeUpsertStats(stats, await upsertBatch(localColl, batch, { dryRun }));
      batch = [];
    }
  }
  if (batch.length > 0) mergeUpsertStats(stats, await upsertBatch(localColl, batch, { dryRun }));

  return stats;
};

export const listSyncCollections = async (db, filterNames = []) => {
  const all = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !shouldSkipCollection(n))
    .sort();
  if (filterNames.length === 0) return all;
  const wanted = new Set(filterNames);
  const missing = filterNames.filter((n) => !all.includes(n));
  if (missing.length) throw new Error(`collection(s) not found in source db: ${missing.join(', ')}`);
  return all.filter((n) => wanted.has(n));
};

const formatSkip = (n) => (n ? `  skip-newer ${String(n).padStart(7)}` : '');

const printUpsertRow = (name, stats, dryRun) => {
  if (dryRun) {
    console.log(
      `${name.padEnd(24)}  would insert ${String(stats.wouldInsert).padStart(7)}  would update ${String(stats.wouldUpdate).padStart(7)}${formatSkip(stats.wouldSkipNewerLocal)}${
        stats.wouldDeleteLocalOnly ? `  would delete-local ${String(stats.wouldDeleteLocalOnly).padStart(7)}` : ''
      }${stats.wouldSkipDeleteNewerLocal ? `  skip-del ${String(stats.wouldSkipDeleteNewerLocal).padStart(7)}` : ''}`
    );
    return;
  }
  console.log(
    `${name.padEnd(24)}  inserted ${String(stats.inserted).padStart(7)}  updated ${String(stats.updated).padStart(7)}${formatSkip(stats.skippedNewerLocal)}${
      stats.deletedLocalOnly ? `  deleted-local ${String(stats.deletedLocalOnly).padStart(7)}` : ''
    }${stats.skippedDeleteNewerLocal ? `  skip-del ${String(stats.skippedDeleteNewerLocal).padStart(7)}` : ''}`
  );
};

const runUpsertSync = async (args, cloudUri, cloudDb, localUri, localDb) => {
  const startedAt = Date.now();
  const cloudClient = await MongoClient.connect(cloudUri, { serverSelectionTimeoutMS: 15000 });
  const localClient = await MongoClient.connect(localUri, { serverSelectionTimeoutMS: 8000 });
  try {
    const cloudDbHandle = cloudClient.db(cloudDb);
    const localDbHandle = localClient.db(localDb);
    const collections = await listSyncCollections(cloudDbHandle, args.collections);

    console.log(`\n== upsert sync: ${collections.length} collection(s)${args.dryRun ? ' (dry-run)' : ''} ==`);
    if (args.collections.length) console.log(`filter : ${args.collections.join(', ')}`);
    if (args.deleteLocalOnly) {
      console.log('prune  : local documents absent in cloud may be deleted (newer local-only docs preserved)');
    }
    console.log('conflict: skip when local timestamp > cloud timestamp');

    if (!args.dryRun && !args.noBackup) {
      requireTools(['mongodump']);
      const backupRoot = process.env.MIRROR_BACKUP_DIR || 'backups';
      console.log(`\n== backup local db before upsert -> ${backupRoot}/ ==`);
      const backupPath = dumpLocalBackup(localUri, localDb, backupRoot);
      console.log(`backup saved: ${backupPath}`);
    } else if (!args.dryRun && args.noBackup) {
      console.log('\nbackup skipped (--no-backup)');
    }

    const totals = emptyUpsertStats();
    for (const name of collections) {
      const stats = await syncCollectionUpsert(cloudDbHandle.collection(name), localDbHandle.collection(name), {
        dryRun: args.dryRun,
        deleteLocalOnly: args.deleteLocalOnly,
      });
      mergeUpsertStats(totals, stats);
      printUpsertRow(name, stats, args.dryRun);
    }

    if (args.dryRun) {
      console.log(
        `\nDRY-RUN totals: would insert ${totals.wouldInsert}, would update ${totals.wouldUpdate}, would skip-newer-local ${totals.wouldSkipNewerLocal}${
          args.deleteLocalOnly
            ? `, would delete-local ${totals.wouldDeleteLocalOnly}, would skip-delete-newer ${totals.wouldSkipDeleteNewerLocal}`
            : ''
        } (no writes performed)`
      );
    } else {
      console.log(
        `\nUPSERT totals: inserted ${totals.inserted}, updated ${totals.updated}, skipped-newer-local ${totals.skippedNewerLocal}${
          args.deleteLocalOnly
            ? `, deleted-local ${totals.deletedLocalOnly}, skipped-delete-newer ${totals.skippedDeleteNewerLocal}`
            : ''
        }`
      );
    }
    console.log(`upsert elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    await Promise.all([cloudClient.close(), localClient.close()]);
  }
};

const selftest = () => {
  const srv = 'mongodb+srv://user:p%40ss@cluster0.abc.mongodb.net/uat-dharwin?retryWrites=true';
  assert.equal(dbNameOf(srv), 'uat-dharwin');
  assert.equal(dbNameOf('mongodb://127.0.0.1:27017/copy'), 'copy');
  assert.equal(mask(srv).includes('p%40ss'), false);
  assert.match(mask(srv), /\/\/user:\*\*\*@/);
  assert.equal(stripDb('mongodb://127.0.0.1:27017/copy'), 'mongodb://127.0.0.1:27017/');
  assert.deepEqual(nsArgs('a', 'a'), []);
  assert.deepEqual(nsArgs('a', 'b'), ['--nsFrom', 'a.*', '--nsTo', 'b.*']);

  assert.match(withParams(srv, { readPreference: 'secondaryPreferred' }), /readPreference=secondaryPreferred/);
  assert.match(withParams(srv, { retryWrites: 'false' }), /retryWrites=true/);

  assert.equal(isSafeTarget('mongodb://127.0.0.1:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://localhost:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://172.31.4.10:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://10.0.1.5:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://172.15.0.1:27017/x'), false);
  assert.equal(isSafeTarget(srv), false);

  const one = (count, indexes = 1) => ({ count, indexes });
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(2)]])), true);
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(1)]])), false);
  assert.equal(report(new Map([['a', one(2, 3)]]), new Map([['a', one(2, 1)]])), false);
  assert.equal(report(new Map([['a', one(2)]]), new Map()), false);
  assert.equal(report(new Map(), new Map([['a', one(1)]])), false);

  assert.deepEqual(parseArgs(['--jobs', '4']).jobs, 4);
  assert.throws(() => parseArgs(['--jobs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--yes']), /no longer supported/);
  assert.throws(() => parseArgs(['--archive', 'a']), /no longer supported/);
  assert.throws(() => parseArgs(['--from-archive', 'a']), /no longer supported/);
  assert.throws(() => parseArgs(['--local', 'mongodb://127.0.0.1:27017/x']), /no longer supported/);
  assert.throws(() => parseArgs(['--upsert']), /no longer supported/);
  assert.throws(() => parseArgs(['--dry-run', '--verify-only']), /mutually exclusive/);
  assert.deepEqual(parseArgs(['--collections=users,employees']).collections, ['users', 'employees']);
  assert.equal(shouldSkipCollection('system.views'), true);
  assert.equal(shouldSkipCollection('sessions'), true);
  assert.equal(shouldSkipCollection('users'), false);
  assert.throws(() => validateUri('not-a-uri', 'cloud'), /not a valid MongoDB URI/);
  assert.throws(() => validateUri('mongodb://127.0.0.1:27017/', 'local'), /must include a database name/);
  assert.equal(validateUri('mongodb://127.0.0.1:27017/uat-dharwin', 'local'), 'uat-dharwin');

  assert.equal(isMirrorEnabled(), false);
  process.env[MIRROR_ENABLE_ENV] = 'TRUE';
  assert.equal(isMirrorEnabled(), true);
  process.env[MIRROR_ENABLE_ENV] = 'false';
  assert.throws(() => requireMirrorEnabled(), /MIRROR_CLOUD_TO_LOCAL_ENABLED=true is required/);
  delete process.env[MIRROR_ENABLE_ENV];

  const prevCloud = process.env.CLOUD_MONGODB_URL;
  const prevLocal = process.env.LOCAL_MONGODB_URL;
  delete process.env.CLOUD_MONGODB_URL;
  delete process.env.LOCAL_MONGODB_URL;
  assert.throws(() => requireEnvUri('CLOUD_MONGODB_URL'), /CLOUD_MONGODB_URL is required/);
  assert.throws(() => requireEnvUri('LOCAL_MONGODB_URL'), /LOCAL_MONGODB_URL is required/);
  if (prevCloud) process.env.CLOUD_MONGODB_URL = prevCloud;
  if (prevLocal) process.env.LOCAL_MONGODB_URL = prevLocal;

  const t1 = new Date('2026-01-01T00:00:00Z');
  const t2 = new Date('2026-06-01T00:00:00Z');
  assert.equal(getDocTimestamp({ updatedAt: t2, createdAt: t1 }), t2.getTime());
  assert.equal(getDocTimestamp({ modifiedAt: '2026-03-01T00:00:00.000Z' }), Date.parse('2026-03-01T00:00:00.000Z'));
  assert.equal(getDocTimestamp({ createdAt: 1000 }), 1000);
  assert.equal(getDocTimestamp({}), null);
  assert.equal(maxTimestamp(100, 200), 200);
  assert.equal(maxTimestamp(null, 200), 200);

  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t1 }, { updatedAt: t2 }), true);
  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t2 }, { updatedAt: t1 }), false);
  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t1 }, { updatedAt: t1 }), false);
  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t2 }, {}), false);
  assert.equal(shouldSkipCloudOverwrite({}, { updatedAt: t2 }), false);

  assert.equal(shouldSkipLocalDelete({ updatedAt: t2 }, t1.getTime()), true);
  assert.equal(shouldSkipLocalDelete({ updatedAt: t1 }, t2.getTime()), false);
  assert.equal(shouldSkipLocalDelete({ updatedAt: t2 }, null), true);
  assert.equal(shouldSkipLocalDelete({}, t2.getTime()), false);

  assert.equal(classifyCloudDoc({ updatedAt: t1 }, null), 'insert');
  assert.equal(classifyCloudDoc({ updatedAt: t2 }, { updatedAt: t1 }), 'update');
  assert.equal(classifyCloudDoc({ updatedAt: t1 }, { updatedAt: t2 }), 'skip-newer-local');

  assert.match(backupDirName(), /^mirror-local-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.equal(parseArgs(['--no-backup']).noBackup, true);
  assert.equal(parseArgs(['--dry-run']).noBackup, false);

  console.log('selftest OK');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();

  requireMirrorEnabled();

  const rawCloudUri = requireEnvUri('CLOUD_MONGODB_URL');
  const localUri = requireEnvUri('LOCAL_MONGODB_URL');
  validateUri(rawCloudUri, 'cloud source');
  validateUri(localUri, 'local target');

  const cloudDb = dbNameOf(rawCloudUri);
  const localDb = dbNameOf(localUri);

  const cloudUri = withParams(rawCloudUri, { readPreference: 'secondaryPreferred' });

  if (!isSafeTarget(localUri) && !args.force) {
    throw new Error(
      `refusing to restore into non-private host ${new URL(localUri).hostname} (pass --force if you really mean it)`
    );
  }
  if (stripDb(rawCloudUri) === stripDb(localUri) && cloudDb === localDb && !args.force) {
    throw new Error('cloud and local URIs point to the same database (pass --force if intentional)');
  }

  console.log(`source : ${mask(rawCloudUri)}  (db ${cloudDb}, readPreference=secondaryPreferred)`);
  console.log(`target : ${mask(localUri)}  (db ${localDb})`);
  console.log(
    `mode   : ${
      args.verifyOnly
        ? 'verify only'
        : `upsert${args.dryRun ? ' (dry-run)' : ''}${args.noBackup ? ' (no-backup)' : ''}${args.deleteLocalOnly ? ' + delete-local-only' : ''}`
    }, jobs=${args.jobs}`
  );

  const startedAt = Date.now();

  if (!args.verifyOnly) {
    if (!args.dryRun) {
      await snapshot(cloudUri, cloudDb, { fast: true, timeoutMs: 15000 });
      await snapshot(localUri, localDb, { fast: true, timeoutMs: 8000 });
    }
    await runUpsertSync(args, cloudUri, cloudDb, localUri, localDb);
  }

  if (args.dryRun) {
    console.log('\nverify skipped in dry-run mode');
    console.log(`total elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return;
  }

  console.log(`\n== verify: ${args.fast ? 'estimated' : 'exact'} document counts + index counts on both sides ==`);
  const [cloud, local] = await Promise.all([
    snapshot(cloudUri, cloudDb, { fast: args.fast, timeoutMs: 15000 }),
    snapshot(localUri, localDb, { fast: args.fast, timeoutMs: 8000 }),
  ]);
  if (!report(cloud, local)) process.exitCode = 1;
  console.log(`total elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`);
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  });
}
