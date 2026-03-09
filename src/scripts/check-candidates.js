import mongoose from 'mongoose';
import config from '../config/config.js';

async function checkCandidatesVsUsers() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB');

    // Get candidates table structure
    const Candidate = mongoose.model('Candidate', new mongoose.Schema({}, {strict: false}));
    const candidates = await Candidate.find({ 
      $or: [{ fullName: /prakhar/i }, { email: /prakhar/i }]
    }).select('fullName email userId _id').lean();

    console.log(`\nFound ${candidates.length} candidates matching "prakhar":\n`);
    candidates.forEach((c, i) => {
      console.log(`${i + 1}. Name: ${c.fullName}`);
      console.log(`   Email: ${c.email}`);
      console.log(`   Candidate ID: ${c._id}`);
      console.log(`   User ID (userId field): ${c.userId || 'NOT SET'}`);
      console.log('');
    });

    console.log('\n=== ISSUE FOUND ===');
    console.log('The task board is using CANDIDATE IDs for assignment:');
    console.log('  Task assigned to: 69a1383799f77434c7a614cf, 69a16d0eb5e06be739f8952f');
    console.log('\nBut tasks.assignedTo should store USER IDs, not candidate IDs!');
    console.log('\nTo fix this, we need to:');
    console.log('1. Check if candidates have a userId field linking to users table');
    console.log('2. Update task board to use user IDs instead of candidate IDs');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

checkCandidatesVsUsers();
