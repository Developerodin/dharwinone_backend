import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, generateFileKey, generatePresignedDownloadUrl } from '../config/s3.js';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

// Upload single file directly to S3
const uploadFileToS3 = async (file, userId, folder = 'documents') => {
  try {
    const fileKey = generateFileKey(file.originalname, userId, folder);

    const uploadParams = {
      Bucket: config.aws.bucketName,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        originalName: file.originalname,
        uploadedBy: String(userId),
        uploadedAt: new Date().toISOString(),
      },
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    // Generate a short-lived presigned download URL (useful for immediate preview)
    const url = await generatePresignedDownloadUrl(fileKey, 3600);

    return {
      key: fileKey,
      url,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    };
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload file: ${error.message}`);
  }
};

// Upload multiple files to S3
const uploadMultipleFilesToS3 = async (files, userId, folder = 'documents') => {
  try {
    const uploadPromises = files.map((file) => uploadFileToS3(file, userId, folder));
    const results = await Promise.all(uploadPromises);
    return results;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload files: ${error.message}`);
  }
};

// Delete a single object from S3. Best-effort — logs and swallows errors so DB cleanup proceeds.
const deleteFileFromS3 = async (key) => {
  if (!key) return;
  try {
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: config.aws.bucketName, Key: key })
    );
  } catch (error) {
    // Intentionally swallow — caller has already validated, and DB integrity matters more than S3 cleanup.
    // Stale objects can be reaped by an out-of-band lifecycle policy.
    // eslint-disable-next-line no-console
    console.warn(`[s3] failed to delete ${key}: ${error?.message}`);
  }
};

export { uploadFileToS3, uploadMultipleFilesToS3, deleteFileFromS3 };

