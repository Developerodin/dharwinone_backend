import { PutObjectCommand } from '@aws-sdk/client-s3';
import httpStatus from 'http-status';
import { s3Client, generateFileKey, generatePresignedDownloadUrl } from '../config/s3.js';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';

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

export { uploadFileToS3 };
