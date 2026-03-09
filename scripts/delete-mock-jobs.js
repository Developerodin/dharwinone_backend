/**
 * Delete mock jobs from target (jobs not in source) and their job applications.
 */

import { MongoClient, ObjectId } from 'mongodb';

const TARGET_URI = process.env.TARGET_MONGODB_URL || 'mongodb+srv://nishant9694536092_db_user:OHk9iiNuGHqgMNoY@cluster0.f6aq20s.mongodb.net/uat-dharwin';

const MOCK_JOB_IDS = [
  '69a12b0705f0355c846b663a', '69a12b0705f0355c846b663d', '69a12b0705f0355c846b6641',
  '69a12b0705f0355c846b6643', '69a12b0705f0355c846b6647', '69a12b0705f0355c846b6649',
  '69a12b0705f0355c846b664d', '69a12c7a0c38d11901c4f98d', '69a12c7a0c38d11901c4f98f',
  '69a12c7a0c38d11901c4f991', '69a12c7a0c38d11901c4f993', '69a12c7b0c38d11901c4f995',
  '69a12c7b0c38d11901c4f997', '69a12c7b0c38d11901c4f999', '69a12c7b0c38d11901c4f99b',
  '69a12c7b0c38d11901c4f99d', '69a12c7b0c38d11901c4f99f', '69a12c7b0c38d11901c4f9a1',
  '69a12c7b0c38d11901c4f9a3', '69a12c7b0c38d11901c4f9a5', '69a12c7b0c38d11901c4f9a7',
  '69a12c7b0c38d11901c4f9a9',
];

async function run() {
  const targetClient = new MongoClient(TARGET_URI);
  try {
    await targetClient.connect();
    const targetDb = targetClient.db('uat-dharwin');
    const mockIds = MOCK_JOB_IDS.map((id) => new ObjectId(id));

    const appResult = await targetDb.collection('jobapplications').deleteMany({ job: { $in: mockIds } });
    console.log('Deleted jobapplications:', appResult.deletedCount);

    const jobResult = await targetDb.collection('jobs').deleteMany({ _id: { $in: mockIds } });
    console.log('Deleted jobs:', jobResult.deletedCount);

    console.log('Done.');
  } finally {
    await targetClient.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
