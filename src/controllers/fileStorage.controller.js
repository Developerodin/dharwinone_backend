import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import * as fileStorageService from '../services/fileStorage.service.js';

/**
 * Decode a URI-encoded key once, rejecting malformed encodings.
 */
const decodeKey = (rawKey) => {
  try {
    return decodeURIComponent(rawKey);
  } catch {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid key encoding');
  }
};

const list = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User information missing');
  }
  const { prefix, next: nextToken, maxKeys } = req.query;
  const result = await fileStorageService.listObjects(userId, prefix || '', { next: nextToken, maxKeys });
  res.status(httpStatus.OK).send({
    success: true,
    data: {
      folders: result.folders,
      files: result.files,
      nextContinuationToken: result.nextContinuationToken,
      isTruncated: result.isTruncated,
    },
  });
});

const upload = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User information missing');
  }
  if (!req.file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No file provided');
  }
  const folder = (req.body?.folder || req.query?.folder || '').trim();
  const result = await fileStorageService.uploadFile(userId, req.file, folder);
  res.status(httpStatus.CREATED).send({
    success: true,
    data: result,
  });
});

const download = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User information missing');
  }
  const key = decodeKey(req.query.key);
  const url = await fileStorageService.getDownloadUrl(userId, key);
  res.status(httpStatus.OK).send({
    success: true,
    data: { url },
  });
});

const deleteObject = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User information missing');
  }
  const key = decodeKey(req.query.key);
  await fileStorageService.deleteObject(userId, key);
  res.status(httpStatus.OK).send({
    success: true,
    data: { success: true },
  });
});

const createFolder = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User information missing');
  }
  const folderName = (req.body?.name || '').trim();
  const parentPrefix = (req.body?.prefix || '').trim();
  const fullPath = parentPrefix ? `${parentPrefix}${folderName}` : folderName;
  const result = await fileStorageService.createFolder(userId, fullPath);
  res.status(httpStatus.CREATED).send({
    success: true,
    data: result,
  });
});

export { list, upload, download, deleteObject, createFolder };
