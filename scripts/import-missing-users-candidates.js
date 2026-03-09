/**
 * Import missing users and candidates from source to target.
 * Only copies documents that exist in source but not in target.
 */

import { MongoClient, ObjectId } from 'mongodb';

const SOURCE_URI =
  'mongodb+srv://developer_db_user:tPVZjF82FkuiNjbK@cluster0.xl5essw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const TARGET_URI =
  'mongodb+srv://nishant9694536092_db_user:OHk9iiNuGHqgMNoY@cluster0.f6aq20s.mongodb.net/uat-dharwin';

function toId(idStr) {
  if (ObjectId.isValid(idStr) && String(new ObjectId(idStr)) === idStr) return new ObjectId(idStr);
  return idStr;
}

async function getIds(db, collection) {
  const docs = await db.collection(collection).find({}).project({ _id: 1 }).toArray();
  return new Set(docs.map((d) => d._id.toString()));
}

async function run() {
  const sourceClient = new MongoClient(SOURCE_URI);
  const targetClient = new MongoClient(TARGET_URI);

  try {
    await sourceClient.connect();
    await targetClient.connect();

    const sourceDb = sourceClient.db('test');
    const targetDb = targetClient.db('uat-dharwin');

    // Users - skip any whose email already exists in target (e.g. admin)
    const [sourceUserIds, targetUserIds, targetEmails] = await Promise.all([
      getIds(sourceDb, 'users'),
      getIds(targetDb, 'users'),
      targetDb.collection('users').find({}).project({ email: 1 }).toArray(),
    ]);
    const targetEmailSet = new Set((targetEmails || []).map((u) => (u.email || '').toLowerCase()).filter(Boolean));

    const missingUserIds = [...sourceUserIds].filter((id) => !targetUserIds.has(id));
    if (missingUserIds.length > 0) {
      const ids = missingUserIds.map(toId);
      const missingUsers = await sourceDb.collection('users').find({ _id: { $in: ids } }).toArray();
      const toInsert = missingUsers.filter((u) => !targetEmailSet.has((u.email || '').toLowerCase()));
      if (toInsert.length > 0) {
        await targetDb.collection('users').insertMany(toInsert);
        console.log('Imported users:', toInsert.length, `(skipped ${missingUsers.length - toInsert.length} with duplicate email)`);
      } else {
        console.log('Imported users: 0 (all missing had duplicate email in target)');
      }
    } else {
      console.log('Imported users: 0 (none missing)');
    }

    // Candidates
    const [sourceCandidateIds, targetCandidateIds] = await Promise.all([
      getIds(sourceDb, 'candidates'),
      getIds(targetDb, 'candidates'),
    ]);
    const missingCandidateIds = [...sourceCandidateIds].filter((id) => !targetCandidateIds.has(id));

    if (missingCandidateIds.length > 0) {
      const ids = missingCandidateIds.map(toId);
      const missingCandidates = await sourceDb.collection('candidates').find({ _id: { $in: ids } }).toArray();
      await targetDb.collection('candidates').insertMany(missingCandidates);
      console.log('Imported candidates:', missingCandidates.length);
    } else {
      console.log('Imported candidates: 0 (none missing)');
    }

    console.log('Done.');
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
