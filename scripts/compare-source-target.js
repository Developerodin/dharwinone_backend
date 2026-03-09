/**
 * Compare users, candidates, and jobs between source and target.
 */

import { MongoClient } from 'mongodb';

const SOURCE_URI =
  'mongodb+srv://developer_db_user:tPVZjF82FkuiNjbK@cluster0.xl5essw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const TARGET_URI =
  'mongodb+srv://nishant9694536092_db_user:OHk9iiNuGHqgMNoY@cluster0.f6aq20s.mongodb.net/uat-dharwin';

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

    for (const coll of ['users', 'candidates', 'jobs']) {
      const [sourceIds, targetIds] = await Promise.all([getIds(sourceDb, coll), getIds(targetDb, coll)]);

      const inSourceOnly = [...sourceIds].filter((id) => !targetIds.has(id));
      const inTargetOnly = [...targetIds].filter((id) => !sourceIds.has(id));
      const inBoth = [...sourceIds].filter((id) => targetIds.has(id));

      console.log(`\n=== ${coll.toUpperCase()} ===`);
      console.log(`  Source count: ${sourceIds.size}`);
      console.log(`  Target count: ${targetIds.size}`);
      console.log(`  In both:      ${inBoth.length}`);
      console.log(`  In source only: ${inSourceOnly.length}`);
      console.log(`  In target only: ${inTargetOnly.length}`);

      const same = sourceIds.size === targetIds.size && inSourceOnly.length === 0 && inTargetOnly.length === 0;
      console.log(`  SAME: ${same ? 'YES' : 'NO'}`);
    }
    console.log('\n');
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
