/**
 * Script to fix JobApplications with null candidate references
 * This repairs applications where the candidate creation failed but the application was still created
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;

if (!MONGODB_URL) {
  console.error('❌ MONGODB_URL not found in environment variables');
  process.exit(1);
}

async function fixNullCandidateReferences() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URL);
    console.log('✅ Connected to MongoDB');

    const JobApplication = (await import('../src/models/jobApplication.model.js')).default;
    const Candidate = (await import('../src/models/candidate.model.js')).default;
    const User = (await import('../src/models/user.model.js')).default;

    // Find all applications with null candidate
    const brokenApplications = await JobApplication.find({ candidate: null }).populate('appliedBy');
    
    console.log(`\n📋 Found ${brokenApplications.length} applications with null candidate reference\n`);

    let fixed = 0;
    let notFixed = 0;

    for (const app of brokenApplications) {
      console.log(`\n🔍 Checking application ${app._id}...`);
      
      if (!app.appliedBy) {
        console.log(`  ⚠️  No appliedBy user found, skipping`);
        notFixed++;
        continue;
      }

      const user = await User.findById(app.appliedBy);
      if (!user) {
        console.log(`  ⚠️  User not found, skipping`);
        notFixed++;
        continue;
      }

      console.log(`  👤 User: ${user.name} (${user.email})`);

      // Try to find candidate by email
      const candidate = await Candidate.findOne({ email: user.email.toLowerCase() });
      
      if (candidate) {
        console.log(`  ✅ Found candidate: ${candidate.fullName} (${candidate._id})`);
        
        // Update the application
        app.candidate = candidate._id;
        await app.save();
        
        console.log(`  ✅ Application updated with candidate reference`);
        fixed++;
      } else {
        console.log(`  ❌ No candidate found with email ${user.email}`);
        console.log(`  💡 You may need to manually create a candidate for this user`);
        notFixed++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`  ✅ Fixed: ${fixed}`);
    console.log(`  ❌ Not fixed: ${notFixed}`);
    console.log(`  📋 Total: ${brokenApplications.length}`);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

fixNullCandidateReferences();
