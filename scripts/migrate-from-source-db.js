/**
 * Migrate data from source MongoDB to target MongoDB.
 * READ-ONLY on source (no deletes). Upsert by _id on target.
 *
 * Usage: node scripts/migrate-from-source-db.js
 *
 * Or with env vars:
 *   SOURCE_MONGODB_URL=... TARGET_MONGODB_URL=... node scripts/migrate-from-source-db.js
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const SOURCE_URI = process.env.SOURCE_MONGODB_URL || process.argv[2];
const TARGET_URI = process.env.TARGET_MONGODB_URL || process.argv[3];
const SOURCE_DB = process.env.SOURCE_DB_NAME || 'test';
const BATCH_SIZE = 500;

// Collection map: source name -> target name (if different)
const COLLECTION_MAP = [
  { source: 'roles', target: 'roles' },
  { source: 'subroles', target: 'subroles' },
  { source: 'users', target: 'users' },
  { source: 'accesses', target: 'accesses' },
  { source: 'jobs', target: 'jobs' },
  { source: 'jobtemplates', target: 'jobtemplates' },
  { source: 'candidategroups', target: 'candidategroups' },
  { source: 'candidates', target: 'candidates' },
  { source: 'shifts', target: 'shifts' },
  { source: 'holidays', target: 'holidays' },
  { source: 'applications', target: 'jobapplications' },
  { source: 'projects', target: 'projects' },
  { source: 'tasks', target: 'tasks' },
  { source: 'callrecords', target: 'callrecords' },
  { source: 'chatmessages', target: 'messages' },
  { source: 'meetings', target: 'meetings' },
  { source: 'tokens', target: 'tokens' },
  { source: 'notifications', target: 'notifications' },
  { source: 'recordings', target: 'recordings' },
  { source: 'attendances', target: 'attendances' },
  { source: 'backdatedattendancerequests', target: 'backdatedattendancerequests' },
  { source: 'leaverequests', target: 'leaverequests' },
  { source: 'recruiteractivitylogs', target: 'recruiteractivitylogs' },
  { source: 'loginlogs', target: 'loginlogs' },
  { source: 'supporttickets', target: 'supporttickets' },
  { source: 'activitylogs', target: 'activitylogs' },
  { source: 'projectcomments', target: 'projectcomments' },
  { source: 'taskcomments', target: 'taskcomments' },
  { source: 'deliverables', target: 'deliverables' },
  { source: 'attendancerecords', target: 'attendancerecords' },
  { source: 'attendanceregularizations', target: 'attendanceregularizations' },
];

async function migrateCollection(sourceDb, targetDb, entry) {
  const sourceCol = sourceDb.collection(entry.source);
  const targetCol = targetDb.collection(entry.target);

  const exists = await sourceCol.findOne();
  if (!exists) {
    return { skipped: true, count: 0 };
  }

  const cursor = sourceCol.find({});
  let upserted = 0;

  let batch = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) {
      const ops = batch.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: doc },
          upsert: true,
        },
      }));
      const result = await targetCol.bulkWrite(ops, { ordered: false });
      upserted += (result.upsertedCount || 0) + (result.matchedCount || 0);
      batch = [];
    }
  }

  if (batch.length > 0) {
    const ops = batch.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: doc },
        upsert: true,
      },
    }));
    const result = await targetCol.bulkWrite(ops, { ordered: false });
    upserted += (result.upsertedCount || 0) + (result.matchedCount || 0);
  }

  return { skipped: false, count: upserted };
}

async function run() {
  if (!SOURCE_URI || !TARGET_URI) {
    console.error('Usage: SOURCE_MONGODB_URL=... TARGET_MONGODB_URL=... node scripts/migrate-from-source-db.js');
    console.error('Or: node scripts/migrate-from-source-db.js <SOURCE_URI> <TARGET_URI>');
    process.exit(1);
  }

  // Parse target DB from URI (e.g. ...mongodb.net/uat-dharwin or ...mongodb.net/uat-dharwin?retryWrites=...)
  let targetDbName = 'uat-dharwin';
  try {
    const url = new URL(TARGET_URI.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://'));
    const pathPart = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (pathPart && pathPart !== '?') targetDbName = pathPart;
  } catch (_e) {
    /* use default targetDbName */
  }

  // Source DB: default 'test' when not in URI
  const sourceDbName = SOURCE_DB;

  console.log('Source:', SOURCE_URI.replace(/:[^:@]+@/, ':****@'));
  console.log('Target:', TARGET_URI.replace(/:[^:@]+@/, ':****@'));
  console.log('Source DB:', sourceDbName);
  console.log('Target DB:', targetDbName);
  console.log('');

  const sourceClient = new MongoClient(SOURCE_URI);
  const targetClient = new MongoClient(TARGET_URI);

  try {
    await sourceClient.connect();
    await targetClient.connect();
    console.log('Connected to both clusters.\n');

    const sourceDb = sourceClient.db(sourceDbName);
    const targetDb = targetClient.db(targetDbName);

    const sourceCollections = await sourceDb.listCollections().toArray();
    const sourceNames = new Set(sourceCollections.map((c) => c.name));

    let totalDocs = 0;
    for (const entry of COLLECTION_MAP) {
      if (!sourceNames.has(entry.source)) {
        console.log(`[SKIP] ${entry.source} (not in source)`);
        continue;
      }

      try {
        const { skipped, count } = await migrateCollection(sourceDb, targetDb, entry);
        if (skipped) {
          console.log(`[EMPTY] ${entry.source} -> ${entry.target}`);
        } else {
          console.log(`[OK] ${entry.source} -> ${entry.target}: ${count} docs`);
          totalDocs += count;
        }
      } catch (err) {
        console.error(`[ERROR] ${entry.source} -> ${entry.target}:`, err.message);
      }
    }

    console.log(`\nDone. Total documents migrated: ${totalDocs}`);
  } finally {
    await sourceClient.close();
    await targetClient.close();
    console.log('\nConnections closed.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
