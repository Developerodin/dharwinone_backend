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
import Job from '../models/job.model.js';
import JobApplication from '../models/jobApplication.model.js';
import {
  resolveInterviewApplication,
  classifyTitleJobPositionBackfill,
} from '../services/interviewLinkage.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dry = !apply || args.includes('--dry');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

const linkageWriteFilter = (meetingId) => ({
  _id: meetingId,
  linkageStatus: { $in: [null, undefined, 'unlinked'] },
  linkageRevision: { $in: [0, null] },
});

const syncRecordingSnapshots = async (meeting) => {
  const kind = meeting.meetingKind === 'internal' ? 'internal' : 'interview';
  const interviewId = kind === 'interview' ? meeting._id : null;
  await Recording.updateMany(
    { meetingId: meeting.meetingId },
    {
      $set: {
        meetingKind: kind,
        ...(interviewId ? { interviewId } : { interviewId: null }),
      },
    }
  );
};

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
      },
    };
  }

  const jobPos = (meeting.jobPosition || '').trim();
  const candidateHex = meeting.candidate?.id;
  const jobs = await Job.find({ title: jobPos }).select('_id title').limit(3).lean();
  let hasApplication = false;
  if (jobs.length === 1 && candidateHex && /^[0-9a-fA-F]{24}$/.test(candidateHex)) {
    hasApplication = Boolean(
      await JobApplication.exists({ job: jobs[0]._id, candidate: candidateHex })
    );
  }
  const titleDecision = classifyTitleJobPositionBackfill({
    jobPosition: jobPos,
    candidateId: candidateHex,
    matchingJobCount: jobs.length,
    hasApplication,
  });
  if (titleDecision === 'unlinked_title') {
    return { kind: 'unlinked' };
  }
  if (titleDecision === 'ambiguous') {
    return { kind: 'ambiguous', reason: jobs.length > 1 ? 'duplicate_job_title' : 'title_job_position' };
  }
  if (titleDecision === 'legacy_title_candidate') {
    const jobId = jobs[0]._id;
    const app = await JobApplication.findOne({ job: jobId, candidate: candidateHex })
      .select('_id')
      .lean();
    return {
      kind: 'legacy_title',
      patch: {
        linkageStatus: 'legacy_title_candidate',
        linkageSource: 'backfill_title',
      },
      suggestedApplicationId: app ? String(app._id) : '',
      suggestedJobId: String(jobId),
      suggestedCandidateId: String(candidateHex),
    };
  }

  return { kind: 'unlinked' };
};

const run = async () => {
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  const dbHost = (() => {
    try {
      const u = new URL(config.mongoose.url);
      return u.hostname || 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  console.log(JSON.stringify({ phase: 'preflight', dbHost, dry, apply }, null, 2));

  const counts = {
    scanned: 0,
    updated: 0,
    ambiguous: 0,
    unlinked: 0,
    skipped: 0,
    legacyTitle: 0,
  };
  const ambiguousRows = [];
  const plan = [];

  const cursor = Meeting.find({}).cursor();
  for await (const meeting of cursor) {
    counts.scanned += 1;
    if (meeting.linkageStatus && meeting.linkageStatus !== 'unlinked') {
      counts.skipped += 1;
      plan.push({ meeting, action: 'recordings_only' });
      continue;
    }
    const decision = await classifyMeeting(meeting);
    plan.push({ meeting, decision });
    if (decision.kind === 'ambiguous') {
      counts.ambiguous += 1;
      ambiguousRows.push({
        meetingId: meeting.meetingId,
        _id: String(meeting._id),
        reason: decision.reason,
        jobPosition: meeting.jobPosition,
        candidateId: meeting.candidate?.id,
        suggestedApplicationId: '',
      });
    } else if (decision.kind === 'unlinked') {
      counts.unlinked += 1;
    } else if (decision.kind === 'legacy_title') {
      counts.legacyTitle += 1;
      ambiguousRows.push({
        meetingId: meeting.meetingId,
        _id: String(meeting._id),
        reason: 'legacy_title_candidate',
        jobPosition: meeting.jobPosition,
        candidateId: meeting.candidate?.id,
        suggestedApplicationId: decision.suggestedApplicationId || '',
      });
    } else if (decision.kind === 'exact') {
      counts.updated += 1;
    }
  }

  console.log(JSON.stringify({ phase: 'classified', dbHost, dry, apply, counts }, null, 2));

  if (!dry) {
    for (const item of plan) {
      const { meeting, decision, action } = item;
      if (action === 'recordings_only') {
        await syncRecordingSnapshots(meeting);
        continue;
      }
      if (decision.kind === 'ambiguous') {
        await syncRecordingSnapshots(meeting);
        continue;
      }
      if (decision.kind === 'unlinked') {
        await Meeting.updateOne(linkageWriteFilter(meeting._id), { $set: { linkageStatus: 'unlinked' } });
        await syncRecordingSnapshots(meeting);
        continue;
      }
      if (decision.kind === 'legacy_title' || decision.kind === 'exact') {
        const res = await Meeting.updateOne(linkageWriteFilter(meeting._id), { $set: decision.patch });
        if (res.matchedCount) {
          await syncRecordingSnapshots(meeting);
        } else {
          await syncRecordingSnapshots(meeting);
        }
      }
    }
  }

  if (outPath && ambiguousRows.length) {
    const header = 'meetingId,_id,reason,jobPosition,candidateId,suggestedApplicationId\n';
    const lines = ambiguousRows
      .map((r) =>
        [
          r.meetingId,
          r._id,
          r.reason,
          JSON.stringify(r.jobPosition || ''),
          r.candidateId || '',
          r.suggestedApplicationId || '',
        ].join(',')
      )
      .join('\n');
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), header + lines, 'utf8');
  }

  console.log(JSON.stringify({ dry, dbHost, counts, outPath, ambiguous: ambiguousRows.length }, null, 2));
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
