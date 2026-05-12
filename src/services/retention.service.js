import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import TranscriptSegment from '../models/transcriptSegment.model.js';
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
  await AgentDispatch.deleteMany({ createdAt: { $lt: adCutoff } });
  await SummaryDeadLetter.deleteMany({ movedToDlqAt: { $lt: dlqCutoff } });

  logger.info('[Retention] sweep complete', { summariesPurged: oldSummaries.length });
}
