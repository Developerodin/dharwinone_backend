import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/s3.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

const SAFE_RE = /^[A-Za-z0-9_.-]+$/;

export function buildArtifactKey(meetingId, filename) {
  if (!SAFE_RE.test(meetingId)) throw new Error('invalid meetingId for storage key');
  if (!SAFE_RE.test(filename)) throw new Error('invalid filename for storage key');
  return `meetings/${meetingId}/${filename}`;
}

function bucket() {
  return config.livekit?.s3Bucket || config.aws?.bucketName || 'recordings';
}

export async function uploadJsonToS3({ key, data }) {
  const body = Buffer.from(JSON.stringify(data, null, 0), 'utf8');
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: 'application/json',
    })
  );
  const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: config.ai.presignExpirySeconds,
  });
  logger.info('[AiArtifactStorage] uploaded', { key, bytes: body.length });
  return url;
}
