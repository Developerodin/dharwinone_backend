/**
 * Backfill agentId/purpose/job on CallRecords for correct Job/Recruiter category.
 * Phase 1: Match by Job.verificationCallExecutionId (no API call).
 * Phase 2: Fetch agent_id from Bolna API for remaining records.
 * Run: node scripts/backfillCallRecordAgentId.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URL = process.env.MONGODB_URL;

if (!MONGODB_URL) {
  console.error('❌ MONGODB_URL not found in environment variables');
  process.exit(1);
}

async function backfillCallRecordAgentId() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URL);
    console.log('✅ Connected to MongoDB');

    const CallRecord = (await import('../src/models/callRecord.model.js')).default;
    const Job = (await import('../src/models/job.model.js')).default;
    const bolnaService = (await import('../src/services/bolna.service.js')).default;

    const records = await CallRecord.find({
      executionId: { $exists: true, $nin: [null, ''] },
    })
      .select('_id executionId agentId purpose job')
      .lean();

    console.log(`\n📋 Found ${records.length} call record(s) to backfill\n`);

    if (records.length === 0) {
      console.log('✅ Nothing to backfill.');
      return;
    }

    let updatedPhase1 = 0;
    let updatedPhase2 = 0;
    let notFound = 0;
    let errors = 0;

    const executionIds = records.map((r) => String(r.executionId).trim()).filter(Boolean);
    const jobsByExec = await Job.find({ verificationCallExecutionId: { $in: executionIds } })
      .select('_id verificationCallExecutionId')
      .lean();
    const execToJob = new Map(jobsByExec.map((j) => [String(j.verificationCallExecutionId || '').trim(), j]));

    const needsBolna = [];
    for (const rec of records) {
      const execId = String(rec.executionId || '').trim();
      const job = execToJob.get(execId);
      const update = {};
      if (job && !rec.job) update.job = job._id;
      if (job && !(rec.purpose && rec.purpose.includes('job_posting'))) update.purpose = 'job_posting_verification';
      if (Object.keys(update).length > 0) {
        await CallRecord.updateOne({ _id: rec._id }, { $set: update });
        updatedPhase1 += 1;
        console.log(`  [Phase1] ✅ ${execId} → ${Object.keys(update).join(', ')}`);
      }
      if (!rec.agentId || !rec.agentId.trim()) needsBolna.push(rec);
    }

    console.log(`\nPhase 2: Fetch agent_id from Bolna for ${needsBolna.length} record(s)...\n`);

    for (const rec of needsBolna) {
      try {
        const result = await bolnaService.getExecutionDetails(rec.executionId);
        const agentId = result.details?.agent_id ?? result.details?.agentId;
        if (agentId) {
          await CallRecord.updateOne({ _id: rec._id }, { $set: { agentId: String(agentId).trim() } });
          updatedPhase2 += 1;
          console.log(`  [Phase2] ✅ ${rec.executionId} → agentId: ${agentId}`);
        } else {
          notFound += 1;
        }
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        errors += 1;
        console.error(`  ❌ ${rec.executionId}: ${err.message}`);
      }
    }

    const totalUpdated = updatedPhase1 + updatedPhase2;
    console.log(`\n📊 Summary:`);
    console.log(`  ✅ Phase 1 (Job match): ${updatedPhase1}`);
    console.log(`  ✅ Phase 2 (Bolna API): ${updatedPhase2}`);
    console.log(`  ⚠️  No agent_id in Bolna: ${notFound}`);
    console.log(`  ❌ Errors: ${errors}`);
    console.log(`  📋 Total records: ${records.length}`);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

backfillCallRecordAgentId();
