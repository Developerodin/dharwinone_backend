import {
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/s3.js';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

const FILE_STORAGE_PREFIX = 'file-storage';
const MAX_KEY_LENGTH = 1024;
const DEFAULT_MAX_KEYS = 50;
const PRESIGNED_DOWNLOAD_EXPIRY = 600; // 10 min for on-demand download

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/zip',
  'application/x-rar-compressed',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-tar',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);

const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'html', 'htm', 'xml', 'json', 'rtf',
  'zip', 'rar', '7z', 'tar', 'gz',
  'mp3', 'wav', 'ogg', 'm4a',
  'mp4', 'webm', 'mov', 'avi', 'mkv',
]);

const MIME_EXTENSION_MAP = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/svg+xml': ['svg'],
  'image/bmp': ['bmp'],
  'application/pdf': ['pdf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'text/plain': ['txt', 'csv', 'rtf', 'html', 'htm', 'xml', 'json'],
  'text/csv': ['csv'],
  'text/html': ['html', 'htm'],
  'text/xml': ['xml'],
  'application/json': ['json'],
  'application/xml': ['xml'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'audio/ogg': ['ogg'],
  'audio/mp4': ['m4a'],
  'video/mp4': ['mp4'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
  'video/x-msvideo': ['avi'],
  'video/x-matroska': ['mkv'],
};

/**
 * Validate uploaded file MIME type and extension.
 * Rejects application/octet-stream and any type/ext not in the allowlists.
 * Optionally checks that the MIME type is consistent with the file extension.
 */
const validateFileType = (file) => {
  const mime = (file.mimetype || '').toLowerCase();
  const ext = ((file.originalname || '').split('.').pop() || '').toLowerCase();

  if (mime === 'application/octet-stream') {
    throw new ApiError(httpStatus.BAD_REQUEST, `File type "${mime}" is not allowed. Please upload a file with a recognized type.`);
  }

  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `MIME type "${mime}" is not allowed. Allowed types: images, documents, audio, video, and archives.`);
  }

  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `File extension ".${ext}" is not allowed.`);
  }

  if (ext && MIME_EXTENSION_MAP[mime]) {
    if (!MIME_EXTENSION_MAP[mime].includes(ext)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `MIME type "${mime}" does not match file extension ".${ext}". Expected: .${MIME_EXTENSION_MAP[mime].join(', .')}`
      );
    }
  }
};

/**
 * Build the user's root prefix: file-storage/{userId}/
 */
const userPrefix = (userId) => `${FILE_STORAGE_PREFIX}/${userId}/`;

/**
 * Validate that a key is under the user's prefix and has no path traversal.
 * Rejects .., %2e%2e, ..%2f, backslash, etc.
 */
const isKeyAllowed = (key, userId) => {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return false;
  const expected = userPrefix(userId);
  if (!key.startsWith(expected)) return false;
  const suffix = key.slice(expected.length);
  // No parent directory segments
  if (suffix.includes('..')) return false;
  if (suffix.includes('%2e%2e') || suffix.includes('%2e%2e/')) return false;
  if (suffix.includes('..%2f') || suffix.includes('%2f..')) return false;
  if (suffix.includes('\\')) return false;
  return true;
};

/**
 * Sanitize path segment (folder or filename): no /, \, .., control chars.
 * Max length for segment to avoid huge keys.
 */
const sanitizeSegment = (value, maxLen = 200) => {
  if (value == null || typeof value !== 'string') return '';
  let s = value
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .replace(/%2e%2e/gi, '')
    .replace(/\.\.%2f/gi, '')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
};

/**
 * Build safe folder path for S3: no leading/trailing slashes from user input, normalized.
 */
const normalizeFolderPath = (folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return '';
  const segments = folderPath
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => sanitizeSegment(seg, 200))
    .filter(Boolean);
  return segments.length ? `${segments.join('/')}/` : '';
};

/**
 * List objects (folders and files) under file-storage/{userId}/ with optional prefix.
 */
const listObjects = async (userId, prefix = '', options = {}) => {
  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }

  const base = userPrefix(userId);
  const pathPrefix = normalizeFolderPath(prefix);
  const fullPrefix = `${base}${pathPrefix}`;
  const maxKeys = Math.min(Number(options.maxKeys) || DEFAULT_MAX_KEYS, 1000);
  const continuationToken = options.next || undefined;

  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: fullPrefix,
    Delimiter: '/',
    MaxKeys: maxKeys,
    ContinuationToken: continuationToken,
  });

  const response = await s3Client.send(command);

  const folders = (response.CommonPrefixes || []).map((cp) => {
    const p = cp.Prefix || '';
    const name = p.slice(fullPrefix.length).replace(/\/$/, '');
    return { name, prefix: p };
  });

  const files = (response.Contents || []).map((obj) => {
    const key = obj.Key || '';
    const name = key.split('/').pop() || key;
    return {
      key,
      name,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
    };
  });

  return {
    folders,
    files,
    nextContinuationToken: response.NextContinuationToken || null,
    isTruncated: response.IsTruncated === true,
  };
};

/**
 * Upload a file to file-storage/{userId}/{folderPath}; returns metadata.
 */
const uploadFile = async (userId, file, folderPath = '') => {
  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }

  validateFileType(file);

  const safeFolder = normalizeFolderPath(folderPath);
  const ext = (file.originalname && file.originalname.split('.').pop()) || 'bin';
  const safeExt = sanitizeSegment(ext, 10) || 'bin';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  const key = `${FILE_STORAGE_PREFIX}/${userId}/${safeFolder}${timestamp}-${random}.${safeExt}`;

  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Generated key exceeds maximum length');
  }

  const uploadParams = {
    Bucket: bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || 'application/octet-stream',
    Metadata: {
      originalName: (file.originalname || file.name || 'file').slice(0, 500),
      uploadedBy: String(userId),
      uploadedAt: new Date().toISOString(),
    },
  };

  const command = new PutObjectCommand(uploadParams);
  await s3Client.send(command);

  return {
    key,
    name: uploadParams.Metadata.originalName,
    size: file.size,
    mimeType: file.mimetype || 'application/octet-stream',
    uploadedAt: uploadParams.Metadata.uploadedAt,
  };
};

/**
 * Get a short-lived presigned download URL. Key must be under file-storage/{userId}/.
 */
const getDownloadUrl = async (userId, key) => {
  if (!isKeyAllowed(key, userId)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied to this object');
  }

  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: 'attachment',
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_DOWNLOAD_EXPIRY });
  return url;
};

/**
 * Delete an object. Key must be under file-storage/{userId}/.
 */
const deleteObject = async (userId, key) => {
  if (!isKeyAllowed(key, userId)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied to this object');
  }

  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }

  const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
  await s3Client.send(command);
  return { success: true };
};

/**
 * Create a virtual folder by uploading a zero-byte placeholder object.
 * S3 uses key prefixes, so the "folder" is the key ending in '/'.
 */
const createFolder = async (userId, folderPath) => {
  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }

  const safePath = normalizeFolderPath(folderPath);
  if (!safePath) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Folder name is required');
  }

  const key = `${FILE_STORAGE_PREFIX}/${userId}/${safePath}`;

  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Folder path exceeds maximum length');
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.alloc(0),
    ContentType: 'application/x-directory',
  });

  await s3Client.send(command);
  return { name: safePath.replace(/\/$/, '').split('/').pop(), prefix: key };
};

/**
 * Upload a PDF buffer under file-storage/{userId}/{folder} — for generated offer letters, etc.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {Buffer} buffer
 * @param {string} [folderPath] e.g. "offer-letters/" — normalized like uploadFile
 * @returns {Promise<{ key: string, size: number, mimeType: string }>}
 */
const uploadPdfBuffer = async (userId, buffer, folderPath = 'offer-letters/') => {
  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid PDF buffer');
  }
  const safeFolder = normalizeFolderPath(folderPath);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  const key = `${FILE_STORAGE_PREFIX}/${userId}/${safeFolder}${timestamp}-${random}.pdf`;
  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Generated key exceeds maximum length');
  }
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
    Metadata: {
      uploadedBy: String(userId),
      uploadedAt: new Date().toISOString(),
    },
  });
  try {
    await s3Client.send(command);
  } catch (e) {
    const name = e?.name || '';
    const msg = String(e?.message || e);
    if (name === 'TimeoutError' || /timeout|ETIMEDOUT|read ETIMEDOUT|socket hang up/i.test(msg)) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Uploading the PDF to storage failed or timed out. Verify AWS_REGION matches the S3 bucket region, the EC2 instance can reach S3, and credentials or the instance IAM role allow s3:PutObject.'
      );
    }
    throw e;
  }
  return { key, size: buffer.length, mimeType: 'application/pdf' };
};

const isFileStorageObjectKey = (key) => {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return false;
  if (!key.startsWith(`${FILE_STORAGE_PREFIX}/`)) return false;
  if (key.includes('..') || key.includes('%2e%2e') || key.includes('\\')) return false;
  return true;
};

/**
 * Read an object that lives under file-storage/ (any user folder). For server-side download after access checks.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
const getObjectBufferByKey = async (key) => {
  if (!isFileStorageObjectKey(key)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied to this object');
  }
  const bucket = config.aws?.bucketName;
  if (!bucket) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'S3 bucket not configured');
  }
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const res = await s3Client.send(command);
  if (!res.Body) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Object not found');
  }
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
};

export {
  listObjects,
  uploadFile,
  getDownloadUrl,
  deleteObject,
  createFolder,
  userPrefix,
  isKeyAllowed,
  uploadPdfBuffer,
  getObjectBufferByKey,
  isFileStorageObjectKey,
};
