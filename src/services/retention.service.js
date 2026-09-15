import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import TranscriptSession from '../models/transcriptSession.model.js';
import TranscriptBatch from '../models/transcriptBatch.model.js';
import TranscriptVersion from '../models/transcriptVersion.model.js';
import Summary from '../models/summary.model.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import SummaryDeadLetter from '../models/summaryDeadLetter.model.js';
import { s3Client } from '../config/s3.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

function cutoff(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function bucket() {
  return config.livekit?.s3Bucket || config.aws?.bucketName || 'recordings';
}

async function deleteS3Object(key) {
  if (!key) return false;
  try {
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: [{ Key: key }] },
      })
    );
    return true;
  } catch (err) {
    logger.warn('[Retention] S3 object delete failed', { key, error: err.message });
    return false;
  }
}

async function purgeS3PrefixForMeeting(meetingId) {
  const prefix = `meetings/${meetingId}/`;
  const list = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: prefix,
      MaxKeys: 100,
    })
  );
  if (!list.Contents?.length) return 0;
  const keys = list.Contents.map((o) => o.Key).filter((k) => k.endsWith('.json'));
  if (!keys.length) return 0;
  await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: bucket(),
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    })
  );
  return keys.length;
}

export async function runRetention() {
  const tCutoff = cutoff(config.retention.transcriptDays);
  const sCutoff = cutoff(config.retention.summaryDays);
  const adCutoff = cutoff(config.retention.agentDispatchDays);
  const dlqCutoff = cutoff(config.retention.dlqDays);

  const oldSummaries = await Summary.find({ generatedAt: { $lt: sCutoff } })
    .select('meetingId')
    .limit(500)
    .lean();
  for (const s of oldSummaries) {
    // eslint-disable-next-line no-await-in-loop
    await TranscriptSegment.deleteMany({ meetingId: s.meetingId });
    // eslint-disable-next-line no-await-in-loop
    await Summary.deleteOne({ meetingId: s.meetingId });
    // eslint-disable-next-line no-await-in-loop
    await purgeS3PrefixForMeeting(s.meetingId).catch((err) =>
      logger.warn('[Retention] S3 purge failed', { meetingId: s.meetingId, error: err.message })
    );
  }

  await TranscriptSegment.deleteMany({ createdAt: { $lt: tCutoff } });

  const oldVersions = await TranscriptVersion.find({ updatedAt: { $lt: tCutoff } })
    .select('s3Key')
    .limit(500)
    .lean();
  for (const v of oldVersions) {
    // eslint-disable-next-line no-await-in-loop
    const deleted = await deleteS3Object(v.s3Key);
    if (deleted) {
      // eslint-disable-next-line no-await-in-loop
      await TranscriptVersion.deleteOne({ _id: v._id });
    }
  }

  const oldSessions = await TranscriptSession.find({ updatedAt: { $lt: tCutoff } })
    .select('_id')
    .limit(500)
    .lean();
  for (const s of oldSessions) {
    // eslint-disable-next-line no-await-in-loop
    await TranscriptBatch.deleteMany({ sessionId: s._id });
    // eslint-disable-next-line no-await-in-loop
    await TranscriptSession.deleteOne({ _id: s._id });
  }

  await AgentDispatch.deleteMany({ createdAt: { $lt: adCutoff } });
  await SummaryDeadLetter.deleteMany({ movedToDlqAt: { $lt: dlqCutoff } });

  logger.info('[Retention] sweep complete', {
    summariesPurged: oldSummaries.length,
    transcriptVersionsPurged: oldVersions.length,
    transcriptSessionsPurged: oldSessions.length,
  });
}
