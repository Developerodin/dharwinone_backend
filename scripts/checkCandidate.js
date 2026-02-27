import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkCandidate() {
  await mongoose.connect(process.env.MONGODB_URL);
  console.log('Connected to MongoDB');

  const Candidate = (await import('../src/models/candidate.model.js')).default;
  const JobApplication = (await import('../src/models/jobApplication.model.js')).default;

  // Check the specific application
  const app = await JobApplication.findById('69a15d5e342d10ad1fd29c8e').lean();
  console.log('\n📋 Raw JobApplication:', JSON.stringify(app, null, 2));

  // Check if candidate exists
  const candidateId = app.candidate;
  console.log('\n🔍 Looking for candidate:', candidateId);

  const candidate = await Candidate.findById(candidateId).lean();
  console.log('\n👤 Candidate found:', candidate ? JSON.stringify(candidate, null, 2) : 'NULL - CANDIDATE DOES NOT EXIST');

  // Also check via raw collection
  const rawCandidate = await mongoose.connection.db.collection('candidates').findOne({ _id: new mongoose.Types.ObjectId(candidateId) });
  console.log('\n🔍 Raw collection query:', rawCandidate ? JSON.stringify({ _id: rawCandidate._id, fullName: rawCandidate.fullName, email: rawCandidate.email }) : 'NULL - NOT IN COLLECTION');

  // List all candidates to see what we have
  const allCandidates = await Candidate.find({}).select('_id fullName email').lean();
  console.log('\n📋 All candidates in DB:', JSON.stringify(allCandidates, null, 2));

  await mongoose.connection.close();
  console.log('\nDone');
  process.exit(0);
}

checkCandidate().catch(err => { console.error(err); process.exit(1); });
