import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function fixPrakharApplication() {
  await mongoose.connect(process.env.MONGODB_URL);
  console.log('Connected to MongoDB');

  const JobApplication = (await import('../src/models/jobApplication.model.js')).default;

  // Fix the specific Prakhar application
  const appId = '69a15d5e342d10ad1fd29c8e';
  const correctCandidateId = '69a16d0eb5e06be739f8952f'; // Prakhar (sharmaprakhar00o07@gmail.com)

  const result = await JobApplication.updateOne(
    { _id: appId },
    { $set: { candidate: new mongoose.Types.ObjectId(correctCandidateId) } }
  );

  console.log('Update result:', result);

  // Verify
  const app = await JobApplication.findById(appId)
    .populate('candidate', 'fullName email phoneNumber')
    .lean();
  
  console.log('\nVerified application:');
  console.log('  Candidate:', app.candidate);

  await mongoose.connection.close();
  process.exit(0);
}

fixPrakharApplication().catch(err => { console.error(err); process.exit(1); });
