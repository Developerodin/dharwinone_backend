/**
 * Recording visibility diagnostic.
 *
 * Compares S3 recordings bucket against the Recording collection and the
 * Meeting / InternalMeeting visibility-scope index. Surfaces every row that
 * would be hidden from the Recordings page even though a real file exists.
 *
 * Categories reported:
 *   A. S3 file with NO Recording row              (discovery gap)
 *   B. Recording row status=missing but S3 ok     (false negative — recoverable)
 *   C. Recording row status=completed but S3 gone (broken — playback fails)
 *   D. Recording status=completed but meetingId   (scope-hidden — listAll never returns)
 *      not found in Meeting / InternalMeeting
 *   E. Recording rows with status=expired         (backend hides these from listAll)
 *
 * Read-only — performs no DB writes. Safe to run anytime.
 *
 * Usage:
 *   node scripts/diagnose-recordings.js
 *   node scripts/diagnose-recordings.js --limit 1000     # cap S3 scan
 *   node scripts/diagnose-recordings.js --json           # machine-readable
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  if (i > 0 && process.argv[i + 1]) return Math.max(1, Number(process.argv[i + 1]) || 0);
  return 0; // 0 = unlimited
})();

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

async function main() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URL not set in env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  log('Connected to Mongo');

  const { default: config } = await import('../src/config/config.js');
  const { default: Recording } = await import('../src/models/recording.model.js');
  const { default: Meeting } = await import('../src/models/meeting.model.js');
  const { default: InternalMeeting } = await import('../src/models/internalMeeting.model.js');

  // Mirror recordingDiscovery.scheduler.js buildS3 logic so we hit the same
  // bucket Egress writes to.
  const isLiveKitCloud = (config.livekit?.url || '').includes('livekit.cloud');
  const isLocalDev =
    !isLiveKitCloud &&
    (config.env !== 'production' || !config.aws?.accessKeyId || !config.aws?.secretAccessKey);

  let client;
  let bucket;
  if (isLocalDev) {
    client = new S3Client({
      region: 'us-east-1',
      endpoint: config.livekit?.minio?.endpoint || 'http://minio:9000',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.livekit?.minio?.accessKey || 'minioadmin',
        secretAccessKey: config.livekit?.minio?.secretKey || 'minioadmin123',
      },
    });
    bucket = config.livekit?.minio?.bucket || 'recordings';
  } else {
    client = new S3Client({
      region: config.aws?.region || 'us-east-1',
      ...(config.aws?.accessKeyId
        ? {
            credentials: {
              accessKeyId: config.aws.accessKeyId,
              secretAccessKey: config.aws.secretAccessKey,
            },
          }
        : {}),
    });
    bucket = config.livekit?.s3Bucket || config.aws?.bucketName;
  }

  if (!bucket) {
    console.error('No recordings bucket configured (LIVEKIT_S3_BUCKET / AWS_S3_BUCKET_NAME / MinIO bucket).');
    await mongoose.disconnect();
    process.exit(1);
  }
  log(`S3: bucket=${bucket} mode=${isLocalDev ? 'minio' : 'aws-s3'}`);

  // --- Scan S3 ---
  const s3Keys = new Map(); // key → size
  let cont;
  let scanned = 0;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: cont,
      MaxKeys: 1000,
    }));
    for (const obj of res.Contents || []) {
      const k = obj.Key;
      if (!k) continue;
      // Only count video-ish artifacts; ignore stray logs / json next to them.
      if (!/\.(mp4|webm|m4a|ogg)$/i.test(k)) continue;
      s3Keys.set(k, Number(obj.Size || 0));
      scanned += 1;
      if (LIMIT && scanned >= LIMIT) break;
    }
    cont = res.IsTruncated ? res.NextContinuationToken : null;
    if (LIMIT && scanned >= LIMIT) break;
  } while (cont);
  log(`S3 scan: ${s3Keys.size} media object(s)`);

  // --- Load DB state ---
  const recordings = await Recording.find({}, {
    egressId: 1, meetingId: 1, status: 1, filePath: 1, s3Key: 1, bytes: 1,
    startedAt: 1, completedAt: 1, lastError: 1,
  }).lean();
  log(`Recording rows: ${recordings.length}`);

  const recsByKey = new Map(); // s3 key (or filePath) → recording
  for (const r of recordings) {
    const k = r.s3Key || r.filePath;
    if (k) recsByKey.set(k, r);
  }

  // Resolve meetingId allowlist used by recordingScope (admin path —
  // every meeting in the system) to detect rows scope-filter strips.
  const allMeetingIds = new Set();
  const [mIds, iIds] = await Promise.all([
    Meeting.find({}, { meetingId: 1 }).lean(),
    InternalMeeting.find({}, { meetingId: 1 }).lean(),
  ]);
  for (const m of mIds) if (m.meetingId) allMeetingIds.add(m.meetingId);
  for (const m of iIds) if (m.meetingId) allMeetingIds.add(m.meetingId);
  log(`Meeting + InternalMeeting ids: ${allMeetingIds.size}`);

  // --- Categorize ---
  const s3OrphanNoRow = []; // S3 file, no DB row
  const missingButS3Ok = []; // status=missing, S3 file with bytes>0
  const completedButGone = []; // status=completed, S3 missing or zero bytes
  const scopeHidden = []; // status=completed, meetingId not in allMeetingIds
  const expired = []; // status=expired (backend hides)

  for (const [k, size] of s3Keys.entries()) {
    if (!recsByKey.has(k)) s3OrphanNoRow.push({ key: k, bytes: size });
  }

  for (const r of recordings) {
    const k = r.s3Key || r.filePath;
    if (r.status === 'completed') {
      if (!k) {
        completedButGone.push({ id: String(r._id), egressId: r.egressId, reason: 'no filePath' });
      } else if (!s3Keys.has(k)) {
        // Fall back to HEAD — listing might have been truncated by LIMIT.
        try {
          const h = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: k }));
          if (!Number(h.ContentLength)) {
            completedButGone.push({ id: String(r._id), egressId: r.egressId, key: k, reason: 'zero bytes' });
          }
        } catch {
          completedButGone.push({ id: String(r._id), egressId: r.egressId, key: k, reason: 'HEAD failed' });
        }
      }
      if (!allMeetingIds.has(r.meetingId)) {
        scopeHidden.push({
          id: String(r._id),
          egressId: r.egressId,
          meetingId: r.meetingId,
          filePath: k,
          startedAt: r.startedAt,
        });
      }
    }
    if (r.status === 'missing' && k && s3Keys.has(k) && (s3Keys.get(k) || 0) > 0) {
      missingButS3Ok.push({
        id: String(r._id),
        egressId: r.egressId,
        key: k,
        bytes: s3Keys.get(k),
        lastError: r.lastError,
      });
    }
    if (r.status === 'expired') {
      expired.push({ id: String(r._id), egressId: r.egressId, meetingId: r.meetingId, startedAt: r.startedAt });
    }
  }

  const report = {
    summary: {
      s3Objects: s3Keys.size,
      recordingRows: recordings.length,
      meetingIdIndex: allMeetingIds.size,
      s3OrphanNoRow: s3OrphanNoRow.length,
      missingButS3Ok: missingButS3Ok.length,
      completedButGone: completedButGone.length,
      scopeHidden: scopeHidden.length,
      expired: expired.length,
    },
    s3OrphanNoRow: s3OrphanNoRow.slice(0, 50),
    missingButS3Ok: missingButS3Ok.slice(0, 50),
    completedButGone: completedButGone.slice(0, 50),
    scopeHidden: scopeHidden.slice(0, 50),
    expired: expired.slice(0, 50),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log('\n=== Summary ===');
    for (const [k, v] of Object.entries(report.summary)) log(`  ${k.padEnd(22)} ${v}`);
    const dump = (label, rows) => {
      if (!rows.length) return;
      log(`\n=== ${label} (showing ${Math.min(rows.length, 50)} of ${rows.length}) ===`);
      for (const r of rows.slice(0, 50)) log(' ', JSON.stringify(r));
    };
    dump('A. S3 file with no Recording row', report.s3OrphanNoRow);
    dump('B. status=missing but S3 ok', report.missingButS3Ok);
    dump('C. status=completed but S3 gone', report.completedButGone);
    dump('D. status=completed but scope hides it (meetingId not in Meeting/InternalMeeting)', report.scopeHidden);
    dump('E. status=expired (always hidden by listAll)', report.expired);
    log('\nDone.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
