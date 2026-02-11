import config from '../config/config.js';
import { generateFileKey, uploadBuffer, generatePresignedUploadUrl, generatePresignedDownloadUrl, deleteObject } from '../config/s3.js';

/**
 * Direct upload via backend (buffer already in memory, e.g. from multer).
 */
const uploadFileBuffer = async ({ file, userId, folder = 'documents', metadata = {} }) => {
  const key = generateFileKey(file.originalname, userId, folder);

  await uploadBuffer({
    key,
    body: file.buffer,
    contentType: file.mimetype,
    metadata: {
      originalName: file.originalname,
      uploadedBy: userId?.toString() || 'anonymous',
      ...metadata,
    },
  });

  const url = await generatePresignedDownloadUrl(key);

  return {
    bucket: config.aws.bucketName,
    key,
    url,
    size: file.size,
    contentType: file.mimetype,
  };
};

/**
 * Generate a presigned URL for the frontend to upload directly to S3.
 */
const getPresignedUploadUrl = async ({ fileName, contentType, userId, folder = 'documents', expiresInSeconds = 3600 }) => {
  const key = generateFileKey(fileName, userId, folder);
  const url = await generatePresignedUploadUrl(key, contentType, expiresInSeconds);

  return {
    bucket: config.aws.bucketName,
    key,
    url,
    expiresIn: expiresInSeconds,
  };
};

/**
 * Generate a presigned download URL for an existing object.
 */
const getPresignedDownloadUrl = async ({ key, expiresInSeconds = 3600 }) => {
  const url = await generatePresignedDownloadUrl(key, expiresInSeconds);
  return { url, expiresIn: expiresInSeconds };
};

/**
 * Delete an object from S3.
 */
const deleteS3Object = async ({ key }) => {
  await deleteObject(key);
};

export { uploadFileBuffer, getPresignedUploadUrl, getPresignedDownloadUrl, deleteS3Object };

