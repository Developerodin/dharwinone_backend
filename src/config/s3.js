import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from './config.js';

// Same logic as livekit.service: Egress uses MinIO in dev, AWS S3 in production
// Defaults to local MinIO unless explicitly in production with AWS credentials
// For local development: don't set AWS_ACCESS_KEY_ID or set NODE_ENV=development
const isRecordingStorageLocal = () =>
  config.env !== 'production' || !config.aws?.accessKeyId || !config.aws?.secretAccessKey;

// Create S3 client (used for documents/profile uploads and AWS recording playback)
const s3Client = new S3Client({
  region: config.aws?.region,
  credentials: {
    accessKeyId: config.aws?.accessKeyId,
    secretAccessKey: config.aws?.secretAccessKey,
  },
});

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

