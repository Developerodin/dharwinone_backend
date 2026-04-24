import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import config from './config.js';

// Same logic as livekit.service: Egress uses MinIO in dev, AWS S3 in production/Cloud
// LiveKit Cloud: always use AWS S3; Local Docker: MinIO in dev, AWS S3 in prod
const isRecordingStorageLocal = () => {
  if ((config.livekit?.url || '').includes('livekit.cloud')) return false;
  return config.env !== 'production' || !config.aws?.accessKeyId || !config.aws?.secretAccessKey;
};

/**
 * S3Client for the main app bucket (uploads, offer letter PDFs, presigned URLs).
 * When static keys are omitted, do NOT pass `credentials: { undefined, undefined }` — that blocks the
 * default provider chain. On EC2, use an IAM instance role and omit AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
 */
const s3ClientConfig = {
  region: config.aws?.region || 'us-east-1',
  /** Avoid hanging forever if S3 is unreachable (common symptom: “Generate PDF” spinner never ends). */
  requestHandler: new NodeHttpHandler({
    requestTimeout: 60000,
    connectionTimeout: 15000,
  }),
};
if (config.aws?.accessKeyId && config.aws?.secretAccessKey) {
  s3ClientConfig.credentials = {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  };
}
const s3Client = new S3Client(s3ClientConfig);

// MinIO client for recording playback when Egress writes to MinIO (local dev)
let minioS3Client = null;
if (config.livekit?.minio?.accessKey && config.livekit?.minio?.publicEndpoint) {
  try {
    minioS3Client = new S3Client({
      region: 'us-east-1',
      endpoint: config.livekit.minio.publicEndpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.livekit.minio.accessKey,
        secretAccessKey: config.livekit.minio.secretKey,
      },
    });
  } catch (e) {
    // Invalid endpoint; playback will fall back to AWS when not local
  }
}

// Generate presigned URL for uploading
const generatePresignedUploadUrl = async (key, contentType, expiresIn = 3600) => {
  const command = new PutObjectCommand({
    Bucket: config.aws.bucketName,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

// Generate presigned URL for downloading/viewing
const generatePresignedDownloadUrl = async (key, expiresIn = 3600) => {
  const command = new GetObjectCommand({
    Bucket: config.aws.bucketName,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

/**
 * Presigned URL for recording playback.
 * Uses the same storage as Egress: MinIO in local dev, AWS S3 in production.
 * Bucket must match where Egress uploads (LIVEKIT_S3_BUCKET or AWS_S3_BUCKET_NAME in prod).
 */
const generatePresignedRecordingPlaybackUrl = async (key, expiresIn = 3600) => {
  if (isRecordingStorageLocal() && minioS3Client && config.livekit?.minio?.bucket) {
    const command = new GetObjectCommand({
      Bucket: config.livekit.minio.bucket,
      Key: key,
    });
    return getSignedUrl(minioS3Client, command, { expiresIn });
  }
  const bucket = config.livekit?.s3Bucket || config.aws?.bucketName;
  if (!bucket) {
    throw new Error('Recordings bucket not configured (LIVEKIT_S3_BUCKET or AWS_S3_BUCKET_NAME)');
  }
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn });
};

// Generate unique file key
const generateFileKey = (originalName, userId, folder = 'documents') => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 15);
  const extension = originalName.split('.').pop();
  return `${folder}/${userId}/${timestamp}-${randomString}.${extension}`;
};

export {
  s3Client,
  generatePresignedUploadUrl,
  generatePresignedDownloadUrl,
  generatePresignedRecordingPlaybackUrl,
  generateFileKey,
};

