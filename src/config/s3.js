import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import path from 'path';
import config from './config.js';

const isS3Configured = () =>
  !!(config.aws?.accessKeyId && config.aws?.secretAccessKey && config.aws?.bucketName && config.aws?.region);

// Lazy-initialized S3 client (only when AWS env vars are set)
let s3Client = null;
const getS3Client = () => {
  if (!s3Client) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET_NAME.');
    }
    s3Client = new S3Client({
      region: config.aws.region,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      },
    });
  }
  return s3Client;
};

/**
 * Generate a standardized S3 object key.
 * Format: <folder>/<userId>/<timestamp>-<random>.<ext>
 */
const generateFileKey = (originalName, userId, folder = 'documents') => {
  const ext = path.extname(originalName || '').replace('.', '');
  const safeExt = ext || 'bin';
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  const base = `${timestamp}-${random}`;
  const key = `${folder}/${userId || 'anonymous'}/${base}.${safeExt}`;
  return key;
};

/**
 * Upload a buffer directly to S3.
 */
const uploadBuffer = async ({ key, body, contentType, metadata }) => {
  const client = getS3Client();
  const putCommand = new PutObjectCommand({
    Bucket: config.aws.bucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
  });

  await client.send(putCommand);
};

/**
 * Generate a presigned URL for uploading (PUT).
 */
const generatePresignedUploadUrl = async (key, contentType, expiresInSeconds = 3600) => {
  const client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: config.aws.bucketName,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  return url;
};

/**
 * Generate a presigned URL for downloading (GET).
 */
const generatePresignedDownloadUrl = async (key, expiresInSeconds = 3600) => {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: config.aws.bucketName,
    Key: key,
  });

  const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  return url;
};

/**
 * Delete an object from S3.
 */
const deleteObject = async (key) => {
  const client = getS3Client();
  const command = new DeleteObjectCommand({
    Bucket: config.aws.bucketName,
    Key: key,
  });

  await client.send(command);
};

export { getS3Client, isS3Configured, generateFileKey, uploadBuffer, generatePresignedUploadUrl, generatePresignedDownloadUrl, deleteObject };

