/**
 * 86 users have Candidate role but only 83 show in list. Find the 3 missing.
 * Reasons: (1) User status not active/pending, (2) No Candidate document, (3) Candidate isActive: false
 * Run: node scripts/why-86-candidates-show-83.js
 */
import mongoose from 'mongoose';
import config from '../src/config/config.js';
import Candidate from '../src/models/candidate.model.js';
import User from '../src/models/user.model.js';
import Role from '../src/models/role.model.js';

async function run() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB\n');

    const candidateRole = await Role.findOne({ name: /^Candidate$/i }).lean();
    if (!candidateRole) {
      console.log('Candidate role not found in DB.');
      return;
    }

    // Users with Candidate role (any status)
    const allWithRole = await User.find({ roleIds: candidateRole._id })
      .select('name email _id status')
      .lean();
    console.log(`Users with Candidate role (any status): ${allWithRole.length}`);

    // Users with Candidate role AND status active/pending (what the list uses)
    const activePendingWithRole = await User.find({
      roleIds: candidateRole._id,
      status: { $in: ['active', 'pending'] },
    })
      .select('name email _id status')
      .lean();
    console.log(`Users with Candidate role + status active/pending: ${activePendingWithRole.length}`);

    const activePendingIds = new Set(activePendingWithRole.map((u) => u._id.toString()));

    // Candidate documents whose owner has Candidate role + active/pending
    const candidateDocs = await Candidate.find({
      owner: { $in: activePendingWithRole.map((u) => u._id) },
    })
      .select('owner fullName email isActive _id')
      .lean();
    const activeCandidateDocs = candidateDocs.filter((c) => c.isActive !== false);
    console.log(`Candidate docs (owner has role + active/pending): ${candidateDocs.length}`);
    console.log(`Candidate docs with isActive != false (shown in list): ${activeCandidateDocs.length}\n`);

    // --- Find the 3 missing ---

    // (1) Users with Candidate role but status NOT active/pending
    const excludedByStatus = allWithRole.filter((u) => !activePendingIds.has(u._id.toString()));
    if (excludedByStatus.length > 0) {
      console.log('=== Excluded by User status (not active/pending) ===');
      excludedByStatus.forEach((u, i) => {
        console.log(`${i + 1}. ${u.name} (${u.email}) - status: ${u.status}`);
      });
      console.log('');
    }

    // (2) Users with Candidate role + active/pending but NO Candidate document
    const ownerIdsWithDoc = new Set(candidateDocs.map((c) => c.owner.toString()));
    const noCandidateDoc = activePendingWithRole.filter((u) => !ownerIdsWithDoc.has(u._id.toString()));
    if (noCandidateDoc.length > 0) {
      console.log('=== Has Candidate role but no Candidate document ===');
      noCandidateDoc.forEach((u, i) => {
        console.log(`${i + 1}. ${u.name} (${u.email})`);
      });
      console.log('');
    }

    // (3) Candidate document exists but isActive: false (owner has role + active/pending)
    const inactiveDocs = candidateDocs.filter((c) => c.isActive === false);
    if (inactiveDocs.length > 0) {
      console.log('=== Candidate document is inactive (isActive: false) ===');
      inactiveDocs.forEach((c, i) => {
        console.log(`${i + 1}. ${c.fullName} (${c.email}) - owner: ${c.owner}`);
      });
    }

    const totalMissing =
      excludedByStatus.length + noCandidateDoc.length + inactiveDocs.filter((c) =>
        activePendingIds.has(c.owner.toString())
      ).length;
    console.log(`\nTotal accounted for as missing: ${totalMissing}`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

run();
