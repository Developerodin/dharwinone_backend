/**
 * Backfill interview linkage fields on Meeting + recording snapshot ids.
 *
 *   node src/scripts/backfillInterviewLinkage.js --dry
 *   node src/scripts/backfillInterviewLinkage.js --apply --out ./linkage-ambiguous.csv
 *
 * Do not run against production without explicit review. Default is --dry (read-only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import config from '../config/config.js';
import Meeting from '../models/meeting.model.js';
import Recording from '../models/recording.model.js';
import { resolveInterviewApplication } from '../services/interviewLinkage.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dry = !apply || args.includes('--dry');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

const counts = {
  scanned: 0,
  updated: 0,
  ambiguous: 0,
  unlinked: 0,
  skipped: 0,
};

const ambiguousRows = [];

const classifyMeeting = async (meeting) => {
  const resolved = await resolveInterviewApplication(meeting);
  if (resolved.application) {
    const app = resolved.application;
    const jobId = app.job?._id ?? app.job;
    const candidateId = app.candidate?._id ?? app.candidate;
    return {
      kind: 'exact',
      patch: {
        applicationId: app._id,
        jobId,
        candidateId,
        linkageStatus: meeting.applicationId ? 'verified' : 'verified_exact_ids',
        linkageSource: meeting.applicationId ? 'scheduled_with_application' : 'backfill_exact_ids',
        jobPosition: String(jobId),
      },
    };
  }
  const jobPos = (meeting.jobPosition || '').trim();
  if (jobPos && !/^[0-9a-fA-F]{24}$/.test(jobPos) && meeting.candidate?.id) {
    return { kind: 'ambiguous', reason: 'title_job_position' };
  }
  return { kind: 'unlinked' };
};

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const cursor = Meeting.find({}).cursor();
  for await (const meeting of cursor) {
    counts.scanned += 1;
    if (meeting.linkageStatus && meeting.linkageStatus !== 'unlinked') {
      counts.skipped += 1;
      continue;
    }
    const decision = await classifyMeeting(meeting);
    if (decision.kind === 'ambiguous') {
      counts.ambiguous += 1;
      ambiguousRows.push({
        meetingId: meeting.meetingId,
        _id: String(meeting._id),
        reason: decision.reason,
        jobPosition: meeting.jobPosition,
        candidateId: meeting.candidate?.id,
      });
      continue;
    }
    if (decision.kind === 'unlinked') {
      counts.unlinked += 1;
      if (!dry) {
        await Meeting.updateOne(
          { _id: meeting._id, linkageStatus: { $in: [null, undefined, 'unlinked'] } },
          { $set: { linkageStatus: 'unlinked' } }
        );
      }
      continue;
    }
    if (!dry) {
      await Meeting.updateOne({ _id: meeting._id }, { $set: decision.patch });
      await Recording.updateMany(
        { meetingId: meeting.meetingId, interviewId: null },
        { $set: { interviewId: meeting._id, meetingKind: 'interview' } }
      );
      counts.updated += 1;
    } else {
      counts.updated += 1;
    }
  }

  if (outPath && ambiguousRows.length) {
    const header = 'meetingId,_id,reason,jobPosition,candidateId\n';
    const lines = ambiguousRows
      .map((r) =>
        [r.meetingId, r._id, r.reason, JSON.stringify(r.jobPosition || ''), r.candidateId || ''].join(',')
      )
      .join('\n');
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), header + lines, 'utf8');
  }

  console.log(JSON.stringify({ dry, counts, outPath, ambiguous: ambiguousRows.length }, null, 2));
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
