#!/usr/bin/env node
/**
 * Erase interview artifacts for one candidate. Default --dry prints the plan only.
 * Usage: node src/scripts/eraseCandidateInterviewData.js --candidate <id> --dry|--apply
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { planCandidateErasure } from '../services/interviewDataErasure.service.js';

const args = process.argv.slice(2);
const candidateIdx = args.indexOf('--candidate');
const candidateId = candidateIdx >= 0 ? args[candidateIdx + 1] : null;
const apply = args.includes('--apply');
const dry = args.includes('--dry') || !apply;

if (!candidateId) {
  console.error('Usage: node src/scripts/eraseCandidateInterviewData.js --candidate <id> --dry|--apply');
  process.exit(1);
}

async function main() {
  await mongoose.connect(config.mongoose.url);
  const plan = planCandidateErasure({ meetingIds: [], recordingIds: [] });
  console.log(JSON.stringify({ candidateId, dry, plan }, null, 2));
  if (apply) {
    console.error('Apply path not enabled in this build — extend executor before production use.');
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
