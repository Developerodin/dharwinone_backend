/**
 * Clone the cloud (Atlas) Mongo database into a local mongod - built for a fresh
 * EC2 box - then verify every collection, document count and index came across.
 *
 *   node scripts/mirror-cloud-to-local.js                       # stream cloud -> local, then verify
 *   node scripts/mirror-cloud-to-local.js --yes                 # allow a non-empty target db
 *   node scripts/mirror-cloud-to-local.js --local mongodb://127.0.0.1:27017/uat-dharwin
 *   node scripts/mirror-cloud-to-local.js --archive /data/uat.archive   # keep a restorable artifact
 *   node scripts/mirror-cloud-to-local.js --from-archive /data/uat.archive
 *   node scripts/mirror-cloud-to-local.js --verify-only [--fast]
 *   node scripts/mirror-cloud-to-local.js --selftest
 *
 * Source  : MONGODB_URL from .env. Read-only: reads go to a secondary when the
 *           source is a replica set, so the Atlas primary keeps serving the app.
 * Target  : --local, default mongodb://127.0.0.1:27017/<same db name>. Collections
 *           present in the dump are DROPPED on the target before restore.
 * Requires: mongodump + mongorestore on PATH (MongoDB Database Tools).
 *
 * EC2 notes:
 *   - Default mode streams mongodump -> mongorestore over a pipe: no intermediate
 *     dump on disk, so the box needs no spare space beyond the database itself.
 *     Use --archive only when you want a reusable file.
 *   - Wire compression (zstd) is requested on the source URI to cut Atlas egress.
 *   - Preflight pings both ends before any data moves: a wrong URI or a mongod
 *     that is not running fails in seconds instead of after a long transfer.
 *   - Long runs: nohup node scripts/mirror-cloud-to-local.js > mirror.log 2>&1 &
 *   - Atlas users/roles are not part of a database dump; create local users
 *     separately if the EC2 mongod runs with --auth.
 *
 * Exit code 0 only when local matches cloud collection-for-collection.
 */
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const SYSTEM_COLLECTION = /^system\./;
const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

export const dbNameOf = (uri) => decodeURIComponent(new URL(uri).pathname.replace(/^\//, ''));
export const stripDb = (uri) => {
  const u = new URL(uri);
  u.pathname = '/';
  return u.toString();
};
export const mask = (uri) => uri.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
// mongorestore keeps the dump's db name unless told otherwise.
export const nsArgs = (fromDb, toDb) => (fromDb === toDb ? [] : ['--nsFrom', `${fromDb}.*`, '--nsTo', `${toDb}.*`]);
// Never clobber caller-supplied options.
export const withParams = (uri, params) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
};
// Loopback or RFC1918: an EC2 mongod is reachable on 127.0.0.1 or a 172.31.x private IP.
export const isSafeTarget = (uri) => {
  const host = new URL(uri).hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || PRIVATE_HOST.test(host);
};

const parseArgs = (argv) => {
  const out = {
    verifyOnly: false,
    fast: false,
    yes: false,
    force: false,
    selftest: false,
    local: '',
    archive: '',
    fromArchive: '',
    jobs: Math.max(2, Math.min(8, os.cpus().length)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verify-only') out.verifyOnly = true;
    else if (a === '--fast') out.fast = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--local' && argv[i + 1]) out.local = argv[(i += 1)];
    else if (a === '--archive' && argv[i + 1]) out.archive = argv[(i += 1)];
    else if (a === '--from-archive' && argv[i + 1]) out.fromArchive = argv[(i += 1)];
    else if (a === '--jobs' && argv[i + 1]) out.jobs = Number(argv[(i += 1)]);
    else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  if (!Number.isInteger(out.jobs) || out.jobs < 1) throw new Error('--jobs must be a positive integer');
  if (out.archive && out.fromArchive) throw new Error('--archive and --from-archive are mutually exclusive');
  return out;
};

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) throw new Error(`${cmd} failed to start (is it on PATH?): ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`);
};

// mongodump -> mongorestore over a pipe: nothing lands on disk.
const streamTransfer = (dumpArgs, restoreArgs) =>
  new Promise((resolve, reject) => {
    const dump = spawn('mongodump', dumpArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
    const restore = spawn('mongorestore', restoreArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    const failures = [];
    let pending = 2;
    const settle = (name) => (code) => {
      if (code !== 0) failures.push(`${name} exited with code ${code}`);
      pending -= 1;
      if (pending > 0) return;
      if (failures.length) reject(new Error(failures.join('; ')));
      else resolve();
    };
    dump.on('error', (e) => reject(new Error(`mongodump failed to start: ${e.message}`)));
    restore.on('error', (e) => reject(new Error(`mongorestore failed to start: ${e.message}`)));
    dump.stdout.on('error', () => {}); // EPIPE when mongorestore dies first; its exit code is the real error
    restore.stdin.on('error', () => {});
    dump.stdout.pipe(restore.stdin);
    dump.on('close', settle('mongodump'));
    restore.on('close', settle('mongorestore'));
  });

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

/** Collection -> { count, indexes }. Also the preflight reachability check. */
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
      // countDocuments is an exact scan - that is the point of verifying. --fast trades
      // exactness for metadata-only counts on very large databases.
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
  assert.match(withParams(srv, { retryWrites: 'false' }), /retryWrites=true/); // existing value kept

  assert.equal(isSafeTarget('mongodb://127.0.0.1:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://localhost:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://172.31.4.10:27017/x'), true); // EC2 private IP
  assert.equal(isSafeTarget('mongodb://10.0.1.5:27017/x'), true);
  assert.equal(isSafeTarget('mongodb://172.15.0.1:27017/x'), false); // outside RFC1918
  assert.equal(isSafeTarget(srv), false);

  const one = (count, indexes = 1) => ({ count, indexes });
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(2)]])), true);
  assert.equal(report(new Map([['a', one(2)]]), new Map([['a', one(1)]])), false); // count
  assert.equal(report(new Map([['a', one(2, 3)]]), new Map([['a', one(2, 1)]])), false); // index
  assert.equal(report(new Map([['a', one(2)]]), new Map()), false); // missing
  assert.equal(report(new Map(), new Map([['a', one(1)]])), false); // extra

  assert.deepEqual(parseArgs(['--jobs', '4', '--yes']).jobs, 4);
  assert.throws(() => parseArgs(['--jobs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--archive', 'a', '--from-archive', 'b']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--local']), /unknown or incomplete/);
  console.log('selftest OK');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();

  const rawCloudUri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!rawCloudUri) throw new Error('MONGODB_URL not set (.env)');
  const cloudDb = dbNameOf(rawCloudUri);
  if (!cloudDb) throw new Error(`MONGODB_URL has no database name: ${mask(rawCloudUri)}`);

  // Read off a secondary so the clone does not compete with the live app on the primary.
  const cloudUri = withParams(rawCloudUri, { readPreference: 'secondaryPreferred' });
  // zstd/zlib are built into the Go tools; keeps Atlas egress (and its bill) down.
  const dumpUri = withParams(cloudUri, { compressors: 'zstd,zlib' });

  const localUri = args.local || `mongodb://127.0.0.1:27017/${cloudDb}`;
  const localDb = dbNameOf(localUri) || cloudDb;
  if (!isSafeTarget(localUri) && !args.force) {
    throw new Error(
      `refusing to restore into non-private host ${new URL(localUri).hostname} (pass --force if you really mean it)`
    );
  }

  console.log(`source : ${mask(rawCloudUri)}  (db ${cloudDb}, readPreference=secondaryPreferred)`);
  console.log(`target : ${mask(localUri)}  (db ${localDb})`);
  console.log(
    `mode   : ${
      args.verifyOnly
        ? 'verify only'
        : args.fromArchive
        ? `restore from ${args.fromArchive}`
        : args.archive
        ? `dump to ${args.archive}, then restore`
        : 'streamed (no dump on disk)'
    }, jobs=${args.jobs}`
  );

  const startedAt = Date.now();

  if (!args.verifyOnly) {
    requireTools(args.fromArchive ? ['mongorestore'] : ['mongodump', 'mongorestore']);

    // Preflight: fail in seconds on a bad URI or a mongod that is not running,
    // instead of after a long transfer.
    const existing = await snapshot(localUri, localDb, { fast: true, timeoutMs: 8000 });
    if (existing.size > 0 && !args.yes) {
      throw new Error(
        `target db "${localDb}" already has ${existing.size} collection(s) - restore would drop them. Pass --yes to proceed, or point --local at a new db name.`
      );
    }
    if (!args.fromArchive) await snapshot(cloudUri, cloudDb, { fast: true, timeoutMs: 15000 });

    const restoreArgs = (archiveArg, gzip) => [
      '--uri',
      stripDb(localUri),
      archiveArg,
      ...(gzip ? ['--gzip'] : []),
      '--drop',
      '--nsInclude',
      `${cloudDb}.*`,
      ...nsArgs(cloudDb, localDb),
      '--numParallelCollections',
      String(args.jobs),
      '--numInsertionWorkersPerCollection',
      '4',
    ];

    if (args.fromArchive) {
      console.log(`\n== mongorestore <- ${args.fromArchive} ==`);
      run('mongorestore', restoreArgs(`--archive=${args.fromArchive}`, true));
    } else if (args.archive) {
      console.log(`\n== mongodump -> ${args.archive} ==`);
      run('mongodump', [
        '--uri',
        dumpUri,
        `--archive=${args.archive}`,
        '--gzip',
        '--numParallelCollections',
        String(args.jobs),
      ]);
      console.log(`\n== mongorestore <- ${args.archive} ==`);
      run('mongorestore', restoreArgs(`--archive=${args.archive}`, true));
    } else {
      console.log(`\n== mongodump | mongorestore -> ${localDb} (dropping collections present in the dump) ==`);
      await streamTransfer(
        ['--uri', dumpUri, '--archive', '--numParallelCollections', String(args.jobs)],
        restoreArgs('--archive', false)
      );
    }
    console.log(`\ntransfer finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }

  console.log(`\n== verify: ${args.fast ? 'estimated' : 'exact'} document counts + index counts on both sides ==`);
  const [cloud, local] = await Promise.all([
    snapshot(cloudUri, cloudDb, { fast: args.fast, timeoutMs: 15000 }),
    snapshot(localUri, localDb, { fast: args.fast, timeoutMs: 8000 }),
  ]);
  if (!report(cloud, local)) process.exitCode = 1;
  console.log(`total elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`);
};

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exitCode = 1;
});
