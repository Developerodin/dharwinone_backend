/**
 * Delete mock users and candidates from target (not in source).
 * Does NOT touch source DB. Does NOT delete admin account.
 */

import { MongoClient, ObjectId } from 'mongodb';

const SOURCE_URI =
  'mongodb+srv://developer_db_user:tPVZjF82FkuiNjbK@cluster0.xl5essw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const TARGET_URI =
  'mongodb+srv://nishant9694536092_db_user:OHk9iiNuGHqgMNoY@cluster0.f6aq20s.mongodb.net/uat-dharwin';

async function run() {
  const sourceClient = new MongoClient(SOURCE_URI);
  const targetClient = new MongoClient(TARGET_URI);

  try {
    await sourceClient.connect();
    await targetClient.connect();

    const sourceDb = sourceClient.db('test');
    const targetDb = targetClient.db('uat-dharwin');

    const sourceUsers = await sourceDb.collection('users').find({}).project({ _id: 1 }).toArray();
    const sourceCandidates = await sourceDb.collection('candidates').find({}).project({ _id: 1 }).toArray();

    const sourceUserIds = new Set(sourceUsers.map((u) => u._id.toString()));
    const sourceCandidateIds = new Set(sourceCandidates.map((c) => c._id.toString()));

    const targetUsers = await targetDb.collection('users').find({}).project({ _id: 1, email: 1, roleIds: 1 }).toArray();
    const targetCandidates = await targetDb.collection('candidates').find({}).project({ _id: 1 }).toArray();

    const roles = await targetDb.collection('roles').find({}).project({ _id: 1, name: 1 }).toArray();
    const adminRole = roles.find((r) => (r.name || '').toLowerCase() === 'administrator');
    const adminRoleId = adminRole ? adminRole._id.toString() : null;

    const adminEmails = new Set(
      ['admin@gmail.com', 'admin@dharwin.com', 'administrator@dharwin.com', 'admin@example.com'].map((e) =>
        e.toLowerCase()
      )
    );

    const mockUserIds = targetUsers
      .filter((u) => {
        if (sourceUserIds.has(u._id.toString())) return false;
        const email = (u.email || '').toLowerCase();
        if (adminEmails.has(email)) return false;
        if (adminRoleId && (u.roleIds || []).some((r) => r.toString() === adminRoleId)) return false;
        return true;
      })
      .map((u) => u._id);

    const mockCandidateIds = targetCandidates
      .filter((c) => !sourceCandidateIds.has(c._id.toString()))
      .map((c) => c._id);

    console.log('Mock users to delete (excluding admin):', mockUserIds.length);
    console.log('Mock candidates to delete:', mockCandidateIds.length);

    if (mockCandidateIds.length > 0) {
      const appResult = await targetDb.collection('jobapplications').deleteMany({
        candidate: { $in: mockCandidateIds },
      });
      console.log('Deleted jobapplications (for mock candidates):', appResult.deletedCount);
    }

    if (mockCandidateIds.length > 0) {
      const candResult = await targetDb.collection('candidates').deleteMany({ _id: { $in: mockCandidateIds } });
      console.log('Deleted candidates:', candResult.deletedCount);
    }

    if (mockUserIds.length > 0) {
      await targetDb.collection('tokens').deleteMany({ user: { $in: mockUserIds } });
      const userResult = await targetDb.collection('users').deleteMany({ _id: { $in: mockUserIds } });
      console.log('Deleted users:', userResult.deletedCount);
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
