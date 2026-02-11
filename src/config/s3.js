import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from './config.js';

// Create S3 client
const s3Client = new S3Client({
  region: config.aws?.region,
  credentials: {
    accessKeyId: config.aws?.accessKeyId,
    secretAccessKey: config.aws?.secretAccessKey,
  },
});

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

// Generate unique file key
const generateFileKey = (originalName, userId, folder = 'documents') => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 15);
  const extension = originalName.split('.').pop();
  return `${folder}/${userId}/${timestamp}-${randomString}.${extension}`;
};

export { s3Client, generatePresignedUploadUrl, generatePresignedDownloadUrl, generateFileKey };

