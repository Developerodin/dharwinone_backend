/**
 * One-time cloud (Atlas) -> local Mongo dump via timestamp-aware upsert merge.
 * Purely additive. It never drops a collection, never deletes a document, never drops
 * an index, and never uses mongorestore --drop. Local-only data always survives.
 *
 *   node scripts/mirror-cloud-to-local.js                       # index + document upsert, then verify
 *   node scripts/mirror-cloud-to-local.js --dry-run               # preview actions (no writes)
 *   node scripts/mirror-cloud-to-local.js --verify-only [--fast]  # read-only comparison
 *   node scripts/mirror-cloud-to-local.js --selftest              # unit checks (no DB)
 *
 * Optional upsert flags:
 *   node scripts/mirror-cloud-to-local.js --no-backup             # skip pre-upsert local mongodump
 *   node scripts/mirror-cloud-to-local.js --collections=users,employees
 *
 * Indexes:
 *   Cloud indexes missing locally are created before that collection's documents are
 *   written, so local unique constraints match cloud during the merge. Local-only
 *   indexes are left in place. A creation failure (e.g. a unique index over local rows
 *   that already hold duplicates) is reported and the run continues.
 *
 * Conflict resolution (matched by _id):
 *   Each document's "freshness" is the first parseable timestamp among (in order):
 *     updatedAt, modifiedAt, createdAt, lastModified
 *   - local timestamp > cloud timestamp  -> skip (keep local; counted as skipped-newer-local)
 *   - cloud timestamp >= local timestamp -> cloud wins (replaceOne upsert)
 *   - either side missing a timestamp    -> cloud wins (same as cloud >= local)
 *
 * Unique-key collisions (E11000):
 *   Documents are matched by _id, so a cloud doc can collide with a local doc that
 *   shares a non-_id unique index key under a different _id. Those writes are counted
 *   as dup-key and skipped - never resolved by deleting the local document. The sync
 *   continues (it does not abort mid-run leaving later collections unsynced) and the
 *   conflicts are reported for manual review.
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
 * Exit code 0 when every cloud collection exists locally with at least the cloud
 * document count and every cloud index present. Extra local collections, documents and
 * indexes are expected (nothing is deleted) and do not fail the verify.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

export const shouldSkipCloudOverwrite = (cloudDoc, localDoc) => {
  const cloudTs = getDocTimestamp(cloudDoc);
  const localTs = getDocTimestamp(localDoc);
  return localTs != null && cloudTs != null && localTs > cloudTs;
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

/** Flags that once existed and could destroy local data, plus one that never did anything. */
const REMOVED_FLAGS = new Set([
  '--yes',
  '--archive',
  '--from-archive',
  '--local',
  '--upsert',
  '--delete-local-only',
  '--resolve-dup-keys',
  '--jobs',
]);

const parseArgs = (argv) => {
  const out = {
    verifyOnly: false,
    fast: false,
    force: false,
    selftest: false,
    dryRun: false,
    noBackup: false,
    collections: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (REMOVED_FLAGS.has(a)) {
      throw new Error(
        `${a} is no longer supported — this script only adds data (upsert + index create) and never deletes (see header comment)`
      );
    }
    if (a === '--verify-only') out.verifyOnly = true;
    else if (a === '--fast') out.fast = true;
    else if (a === '--force') out.force = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-backup') out.noBackup = true;
    else if (a.startsWith('--collections=')) out.collections = parseCollectionsArg(a.slice('--collections='.length));
    else if (a === '--collections' && argv[i + 1]) out.collections = parseCollectionsArg(argv[(i += 1)]);
    else throw new Error(`unknown or incomplete argument: ${a}`);
  }
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

/** Same collection filter as the sync, so excluded collections never fail the verify. */
const snapshot = async (uri, dbName, { fast = false, timeoutMs = 10000 } = {}) => {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: timeoutMs });
  try {
    const db = client.db(dbName);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !shouldSkipCollection(n))
      .sort();
    const out = new Map();
    for (const name of names) {
      const coll = db.collection(name);
      const [count, indexes] = await Promise.all([
        fast ? coll.estimatedDocumentCount() : coll.countDocuments(),
        coll.indexes(),
      ]);
      out.set(name, { count, indexNames: indexes.map((ix) => ix.name).sort() });
    }
    return out;
  } finally {
    await client.close();
  }
};

/** Statuses that mean cloud data did not make it locally. Extra local data is expected. */
const FAILING_STATUSES = new Set(['MISSING-LOCAL', 'COUNT-SHORT', 'MISSING-INDEX']);

export const missingIndexNames = (cloudNames = [], localNames = []) => {
  const have = new Set(localNames);
  return cloudNames.filter((n) => !have.has(n));
};

export const classifyVerifyRow = (c, l) => {
  if (c === null) return { status: 'LOCAL-ONLY', missingIdx: [] };
  if (l === null) return { status: 'MISSING-LOCAL', missingIdx: c.indexNames ?? [] };
  const missingIdx = missingIndexNames(c.indexNames, l.indexNames);
  if (l.count < c.count) return { status: 'COUNT-SHORT', missingIdx };
  if (missingIdx.length) return { status: 'MISSING-INDEX', missingIdx };
  if (l.count > c.count) return { status: 'LOCAL-EXTRA', missingIdx };
  return { status: 'OK', missingIdx };
};

export const report = (cloud, local) => {
  const names = [...new Set([...cloud.keys(), ...local.keys()])].sort();
  const rows = names.map((name) => {
    const c = cloud.get(name) ?? null;
    const l = local.get(name) ?? null;
    return { name, c, l, ...classifyVerifyRow(c, l) };
  });

  const pad = Math.max(10, ...rows.map((r) => r.name.length));
  const cell = (v) => String(v ?? '-').padStart(9);
  console.log(`\n${'collection'.padEnd(pad)}  ${'cloud'.padStart(9)}  ${'local'.padStart(9)}  ${'idx'.padStart(7)}  status`);
  console.log('-'.repeat(pad + 45));
  for (const r of rows) {
    const idx = `${r.c ? r.c.indexNames.length : '-'}/${r.l ? r.l.indexNames.length : '-'}`;
    const note = r.status === 'MISSING-INDEX' ? `${r.status} (${r.missingIdx.join(', ')})` : r.status;
    console.log(
      `${r.name.padEnd(pad)}  ${cell(r.c?.count)}  ${cell(r.l?.count)}  ${idx.padStart(7)}  ${
        r.status === 'OK' ? '' : note
      }`
    );
  }

  const bad = rows.filter((r) => FAILING_STATUSES.has(r.status));
  const sum = (m) => [...m.values()].reduce((a, b) => a + b.count, 0);
  console.log(
    `\ncollections: cloud ${cloud.size} / local ${local.size}   documents: cloud ${sum(cloud)} / local ${sum(local)}`
  );
  if (bad.length === 0) {
    console.log(
      'VERIFY OK - every cloud collection exists locally with at least the cloud document count and all cloud indexes present.'
    );
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
  dupKeyConflicts: 0,
});

/**
 * Server-owned index metadata that createIndexes rejects or recomputes.
 * _id_ is created implicitly with the collection and can never be re-created.
 */
const INDEX_META_FIELDS = new Set(['v', 'ns', 'key', 'name', 'background', 'textIndexVersion', '2dsphereIndexVersion']);

export const indexSpecFromCloud = (ix) => ({
  key: ix.key,
  name: ix.name,
  ...Object.fromEntries(Object.entries(ix).filter(([k]) => !INDEX_META_FIELDS.has(k))),
});

/** Cloud indexes absent locally, by name. _id_ is skipped: it always exists. */
export const missingIndexSpecs = (cloudIndexes = [], localIndexes = []) => {
  const have = new Set(localIndexes.map((ix) => ix.name));
  return cloudIndexes.filter((ix) => ix.name !== '_id_' && !have.has(ix.name)).map(indexSpecFromCloud);
};

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

  // ordered:false still writes every non-conflicting op, then throws. Dup-key means a local
  // doc holds this doc's unique key under a different _id - count it and keep syncing rather
  // than aborting the run and leaving every later collection unsynced.
  let result;
  try {
    result = await localColl.bulkWrite(ops, { ordered: false });
  } catch (err) {
    const writeErrors = err?.writeErrors ?? [];
    const dupKey = writeErrors.filter((e) => (e.code ?? e.err?.code) === 11000);
    if (writeErrors.length === 0 || dupKey.length !== writeErrors.length) throw err;
    stats.dupKeyConflicts = dupKey.length;
    result = err.result ?? {};
  }
  stats.inserted = result.upsertedCount ?? 0;
  stats.updated = result.matchedCount ?? 0;
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
  total.dupKeyConflicts += part.dupKeyConflicts;
  return total;
};

/**
 * Create every cloud index the local collection lacks. Runs before the documents so the
 * merge writes under the same unique constraints as cloud. Never drops a local index.
 * A failure (usually a unique index over local rows that already hold duplicates) is
 * returned rather than thrown - one bad index must not stop the dump.
 */
export const syncIndexes = async (cloudColl, localColl, { dryRun = false } = {}) => {
  const out = { created: 0, wouldCreate: 0, failed: [] };
  const [cloudIndexes, localIndexes] = await Promise.all([cloudColl.indexes(), localColl.indexes().catch(() => [])]);
  const specs = missingIndexSpecs(cloudIndexes, localIndexes);
  if (specs.length === 0) return out;
  if (dryRun) {
    out.wouldCreate = specs.length;
    return out;
  }
  for (const spec of specs) {
    try {
      await localColl.createIndexes([spec]);
      out.created += 1;
    } catch (err) {
      out.failed.push({ name: spec.name, message: err.message });
    }
  }
  return out;
};

export const syncCollectionUpsert = async (cloudColl, localColl, { dryRun = false } = {}) => {
  const stats = emptyUpsertStats();
  const batchOpts = { dryRun };

  let batch = [];
  for await (const doc of cloudColl.find({})) {
    batch.push(doc);
    if (batch.length >= UPSERT_BATCH_SIZE) {
      mergeUpsertStats(stats, await upsertBatch(localColl, batch, batchOpts));
      batch = [];
    }
  }
  if (batch.length > 0) mergeUpsertStats(stats, await upsertBatch(localColl, batch, batchOpts));

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

const printUpsertRow = (name, stats, idx, dryRun) => {
  if (dryRun) {
    console.log(
      `${name.padEnd(24)}  would insert ${String(stats.wouldInsert).padStart(7)}  would update ${String(stats.wouldUpdate).padStart(7)}${formatSkip(stats.wouldSkipNewerLocal)}${
        idx.wouldCreate ? `  would add-index ${String(idx.wouldCreate).padStart(3)}` : ''
      }`
    );
    return;
  }
  console.log(
    `${name.padEnd(24)}  inserted ${String(stats.inserted).padStart(7)}  updated ${String(stats.updated).padStart(7)}${formatSkip(stats.skippedNewerLocal)}${
      idx.created ? `  added-index ${String(idx.created).padStart(3)}` : ''
    }${idx.failed.length ? `  INDEX-FAILED ${idx.failed.map((f) => f.name).join(',')}` : ''}${
      stats.dupKeyConflicts ? `  DUP-KEY-SKIPPED ${String(stats.dupKeyConflicts).padStart(7)}` : ''
    }`
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

    console.log(`\n== upsert dump: ${collections.length} collection(s)${args.dryRun ? ' (dry-run)' : ''} ==`);
    if (args.collections.length) console.log(`filter : ${args.collections.join(', ')}`);
    console.log('indexes : missing cloud indexes created locally; local-only indexes kept');
    console.log('conflict: skip when local timestamp > cloud timestamp');
    console.log('deletes : none - no document, collection or index is ever removed');

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
    const indexTotals = { created: 0, wouldCreate: 0, failed: [] };
    for (const name of collections) {
      const cloudColl = cloudDbHandle.collection(name);
      const localColl = localDbHandle.collection(name);
      const idx = await syncIndexes(cloudColl, localColl, { dryRun: args.dryRun });
      indexTotals.created += idx.created;
      indexTotals.wouldCreate += idx.wouldCreate;
      indexTotals.failed.push(...idx.failed.map((f) => ({ ...f, collection: name })));

      const stats = await syncCollectionUpsert(cloudColl, localColl, { dryRun: args.dryRun });
      mergeUpsertStats(totals, stats);
      printUpsertRow(name, stats, idx, args.dryRun);
    }

    if (args.dryRun) {
      console.log(
        `\nDRY-RUN totals: would insert ${totals.wouldInsert}, would update ${totals.wouldUpdate}, would skip-newer-local ${totals.wouldSkipNewerLocal}, would create ${indexTotals.wouldCreate} index(es) (no writes performed)`
      );
    } else {
      console.log(
        `\nUPSERT totals: inserted ${totals.inserted}, updated ${totals.updated}, skipped-newer-local ${totals.skippedNewerLocal}, indexes created ${indexTotals.created}`
      );
      if (indexTotals.failed.length) {
        console.log(`\nWARNING: ${indexTotals.failed.length} index(es) could not be created locally:`);
        for (const f of indexTotals.failed) console.log(`  ${f.collection}.${f.name}: ${f.message}`);
        console.log(
          '  A unique cloud index usually fails because local rows already hold duplicates. ' +
            'Nothing was deleted - resolve the duplicate local documents by hand, then re-run.'
        );
      }
      if (totals.dupKeyConflicts) {
        console.log(
          `\nWARNING: ${totals.dupKeyConflicts} cloud document(s) skipped on unique-key conflict (E11000). ` +
            'A local document holds the same unique key under a different _id, so local is NOT a full mirror. ' +
            'Local data is never deleted to resolve this - fix the conflicting local document, then re-run.'
        );
      }
    }
    console.log(`upsert elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    await Promise.all([cloudClient.close(), localClient.close()]);
  }
};

/** Minimal stand-in for a driver Collection: only what syncIndexes touches. */
const fakeColl = (indexes, { failOn = null } = {}) => ({
  created: [],
  indexes: async () => indexes,
  createIndexes: async function (specs) {
    if (failOn && specs.some((s) => s.name === failOn)) throw new Error(`E11000 duplicate key on ${failOn}`);
    this.created.push(...specs);
  },
});

const selftestSyncIndexes = async () => {
  const cloudIxs = [
    { v: 2, name: '_id_', key: { _id: 1 } },
    { v: 2, name: 'email_1', key: { email: 1 }, unique: true },
    { v: 2, name: 'tenant_1', key: { tenant: 1 } },
  ];

  const local = fakeColl([{ name: '_id_' }]);
  const res = await syncIndexes(fakeColl(cloudIxs), local);
  assert.equal(res.created, 2);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(local.created.map((s) => s.name), ['email_1', 'tenant_1']);

  // dry-run creates nothing
  const dry = fakeColl([{ name: '_id_' }]);
  const dryRes = await syncIndexes(fakeColl(cloudIxs), dry, { dryRun: true });
  assert.equal(dryRes.wouldCreate, 2);
  assert.equal(dryRes.created, 0);
  assert.deepEqual(dry.created, []);

  // one failing index is reported, the rest still get created
  const partial = fakeColl([{ name: '_id_' }], { failOn: 'email_1' });
  const partialRes = await syncIndexes(fakeColl(cloudIxs), partial);
  assert.equal(partialRes.created, 1);
  assert.equal(partialRes.failed.length, 1);
  assert.equal(partialRes.failed[0].name, 'email_1');
  assert.deepEqual(partial.created.map((s) => s.name), ['tenant_1']);

  // nothing missing -> no writes
  const upToDate = fakeColl(cloudIxs);
  assert.deepEqual(await syncIndexes(fakeColl(cloudIxs), upToDate), { created: 0, wouldCreate: 0, failed: [] });
  assert.deepEqual(upToDate.created, []);
};

const selftest = async () => {
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

  const one = (count, indexNames = ['_id_']) => ({ count, indexNames });
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(2)]])), true);
  // local short of cloud fails; local ahead of cloud is fine (nothing is ever deleted)
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(1)]])), false);
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(3)]])), true);
  // every cloud index must exist locally; extra local indexes are fine
  assert.equal(report(new Map([['a', one(2, ['_id_', 'email_1'])]]), new Map([['a', one(2, ['_id_'])]])), false);
  assert.equal(report(new Map([['a', one(2, ['_id_'])]]), new Map([['a', one(2, ['_id_', 'x_1'])]])), true);
  assert.equal(report(new Map([['a', one(2)]]), new Map()), false);
  // a local-only collection is expected, not a failure
  assert.equal(report(new Map(), new Map([['a', one(1)]])), true);

  assert.deepEqual(classifyVerifyRow(one(2), one(2)).status, 'OK');
  assert.deepEqual(classifyVerifyRow(one(2), one(5)).status, 'LOCAL-EXTRA');
  assert.deepEqual(classifyVerifyRow(one(5), one(2)).status, 'COUNT-SHORT');
  assert.deepEqual(classifyVerifyRow(one(2), null).status, 'MISSING-LOCAL');
  assert.deepEqual(classifyVerifyRow(null, one(2)).status, 'LOCAL-ONLY');
  assert.deepEqual(classifyVerifyRow(one(2, ['_id_', 'a_1']), one(2)).missingIdx, ['a_1']);
  assert.deepEqual(missingIndexNames(['_id_', 'a_1'], ['_id_']), ['a_1']);
  assert.deepEqual(missingIndexNames(['_id_'], ['_id_', 'b_1']), []);

  assert.throws(() => parseArgs(['--jobs', '4']), /no longer supported/);
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

  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t1 }, { updatedAt: t2 }), true);
  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t2 }, { updatedAt: t1 }), false);
  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t1 }, { updatedAt: t1 }), false);
  assert.equal(shouldSkipCloudOverwrite({ updatedAt: t2 }, {}), false);
  assert.equal(shouldSkipCloudOverwrite({}, { updatedAt: t2 }), false);

  assert.equal(classifyCloudDoc({ updatedAt: t1 }, null), 'insert');
  assert.equal(classifyCloudDoc({ updatedAt: t2 }, { updatedAt: t1 }), 'update');
  assert.equal(classifyCloudDoc({ updatedAt: t1 }, { updatedAt: t2 }), 'skip-newer-local');

  // deletion flags are rejected outright - this script only adds data
  assert.throws(() => parseArgs(['--resolve-dup-keys']), /no longer supported/);
  assert.throws(() => parseArgs(['--delete-local-only']), /no longer supported/);

  const cloudIxs = [
    { v: 2, name: '_id_', key: { _id: 1 } },
    { v: 2, name: 'meetingId_1', key: { meetingId: 1 }, unique: true, ns: 'db.c' },
    { v: 2, name: 'userId_1_adminId_1', key: { userId: 1, adminId: 1 }, unique: true },
    { v: 2, name: 'email_1', key: { email: 1 }, sparse: true },
    { v: 2, name: 'slug_1', key: { slug: 1 }, unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
    { v: 2, name: 'ttl_1', key: { createdAt: 1 }, expireAfterSeconds: 3600 },
  ];
  // _id_ is never re-created; already-present local indexes are left alone
  assert.deepEqual(
    missingIndexSpecs(cloudIxs, [{ name: '_id_' }, { name: 'email_1' }]).map((s) => s.name),
    ['meetingId_1', 'userId_1_adminId_1', 'slug_1', 'ttl_1']
  );
  assert.deepEqual(missingIndexSpecs(cloudIxs, cloudIxs), []);
  assert.deepEqual(missingIndexSpecs([], [{ name: '_id_' }]), []);

  // server-owned metadata (v, ns) is stripped; every option that changes behaviour survives
  assert.deepEqual(indexSpecFromCloud(cloudIxs[1]), { key: { meetingId: 1 }, name: 'meetingId_1', unique: true });
  assert.deepEqual(indexSpecFromCloud(cloudIxs[3]), { key: { email: 1 }, name: 'email_1', sparse: true });
  assert.deepEqual(indexSpecFromCloud(cloudIxs[4]), {
    key: { slug: 1 },
    name: 'slug_1',
    unique: true,
    partialFilterExpression: { slug: { $type: 'string' } },
  });
  assert.deepEqual(indexSpecFromCloud(cloudIxs[5]), {
    key: { createdAt: 1 },
    name: 'ttl_1',
    expireAfterSeconds: 3600,
  });

  assert.match(backupDirName(), /^mirror-local-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.equal(parseArgs(['--no-backup']).noBackup, true);
  assert.equal(parseArgs(['--dry-run']).noBackup, false);

  await selftestSyncIndexes();

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
        : `upsert${args.dryRun ? ' (dry-run)' : ''}${args.noBackup ? ' (no-backup)' : ''}`
    }`
  );

  const startedAt = Date.now();

  if (!args.verifyOnly) {
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
