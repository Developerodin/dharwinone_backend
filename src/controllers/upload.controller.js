import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import { uploadFileToS3 } from '../services/upload.service.js';
import ApiError from '../utils/ApiError.js';

// Single document upload for testing
const uploadSingleDocument = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No file provided');
  }

  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User information missing on request');
  }

  const { label } = req.body;

  const uploadResult = await uploadFileToS3(req.file, userId);

  res.status(httpStatus.CREATED).send({
    success: true,
    message: 'File uploaded successfully',
    data: {
      label: label || uploadResult.originalName,
      ...uploadResult,
    },
  });
});

export { uploadSingleDocument };
