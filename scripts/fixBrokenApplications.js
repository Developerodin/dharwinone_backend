import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function fixBrokenApplications() {
  await mongoose.connect(process.env.MONGODB_URL);
  console.log('Connected to MongoDB');

  const Candidate = (await import('../src/models/candidate.model.js')).default;
  const JobApplication = (await import('../src/models/jobApplication.model.js')).default;
  const User = (await import('../src/models/user.model.js')).default;

  // Get all job applications and check if their candidate reference is valid
  const allApps = await JobApplication.find({}).lean();
  console.log(`\n📋 Found ${allApps.length} total job applications\n`);

  let fixed = 0;

  for (const app of allApps) {
    if (!app.candidate) {
      console.log(`⚠️  App ${app._id}: candidate field is null`);
      continue;
    }

    const candidate = await Candidate.findById(app.candidate).lean();
    if (candidate) continue; // Candidate exists, skip

    console.log(`❌ App ${app._id}: candidate ${app.candidate} does NOT exist`);

    // Find the user who applied
    const user = await User.findById(app.appliedBy).lean();
    if (!user) {
      console.log(`   ⚠️  appliedBy user ${app.appliedBy} not found either`);
      continue;
    }

    console.log(`   👤 Applied by: ${user.name} (${user.email})`);

    // Find matching candidate by email
    const matchingCandidate = await Candidate.findOne({ email: user.email.toLowerCase() }).lean();
    if (matchingCandidate) {
      console.log(`   ✅ Found matching candidate: ${matchingCandidate.fullName} (${matchingCandidate._id})`);

      // Check if another application already exists for this job+candidate combo
      const existingApp = await JobApplication.findOne({ job: app.job, candidate: matchingCandidate._id }).lean();
      if (existingApp && existingApp._id.toString() !== app._id.toString()) {
        console.log(`   ⚠️  Duplicate application exists (${existingApp._id}), deleting broken one`);
        await JobApplication.deleteOne({ _id: app._id });
        fixed++;
        continue;
      }

      await JobApplication.updateOne(
        { _id: app._id },
        { $set: { candidate: matchingCandidate._id } }
      );
      console.log(`   ✅ Application updated!`);
      fixed++;
    } else {
      // Create a new candidate from user data
      console.log(`   💡 No candidate with email ${user.email}, creating one...`);

      // Get the job to find the owner
      const Job = (await import('../src/models/job.model.js')).default;
      const job = await Job.findById(app.job).lean();
      const ownerId = job?.createdBy || job?.owner || app.appliedBy;

      const newCandidate = await Candidate.create({
        owner: ownerId,
        adminId: ownerId,
        fullName: user.name,
        email: user.email.toLowerCase(),
        phoneNumber: user.phoneNumber || '0000000000',
        countryCode: user.countryCode || 'IN',
        qualifications: [],
        experiences: [],
        skills: [],
        socialLinks: [],
      });

      await JobApplication.updateOne(
        { _id: app._id },
        { $set: { candidate: newCandidate._id } }
      );
      console.log(`   ✅ New candidate created (${newCandidate._id}) and application updated!`);
      fixed++;
    }
  }

  console.log(`\n📊 Fixed ${fixed} broken application(s)`);
  await mongoose.connection.close();
  process.exit(0);
}

fixBrokenApplications().catch(err => { console.error(err); process.exit(1); });
