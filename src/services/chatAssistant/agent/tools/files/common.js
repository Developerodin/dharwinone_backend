import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../../../../../config/s3.js';
import config from '../../../../../config/config.js';
import {
  getDownloadUrl as realGetDownloadUrl,
  isKeyAllowed,
  listObjects as realListObjects,
  userPrefix,
} from '../../../../fileStorage.service.js';

// GET /file-storage/list and GET /file-storage/download are requirePermissions('files-storage.read') — AND of one key.
export const FILES_ACCESS = Object.freeze({ allOf: ['files-storage.read'] });

// ponytail: one HeadObject per listed file, because ListObjectsV2 does not return user metadata
// (uploadedBy / originalName). Ceiling is LIST_LIMIT files per call so this stays inside the tool
// timeout. Upgrade: persist that metadata where listObjects can return it without a head per key.
export const LIST_LIMIT = 50;

const TRAVERSAL = /\.\.|%2e%2e|\\/i;

export function callerId(ctx) {
  const id = ctx?.user?.id || ctx?.user?._id;
  if (id == null || String(id).trim() === '') {
    throw new Error('File Storage tools need an authenticated user with an id');
  }
  return String(id);
}

export function folderIsUnsafe(folder) {
  return typeof folder === 'string' && TRAVERSAL.test(folder);
}

function metaValue(metadata, ...keys) {
  if (!metadata || typeof metadata !== 'object') return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function uploadedByFromMetadata(metadata) {
  return metaValue(metadata, 'uploadedby', 'uploadedBy');
}

export function originalNameFromMetadata(metadata) {
  return metaValue(metadata, 'originalname', 'originalName');
}

/** Parent folder under the caller's prefix, or null for a file at the root. */
export function folderOf(key, userId) {
  const base = userPrefix(userId);
  if (typeof key !== 'string' || !key.startsWith(base)) return null;
  const parts = key.slice(base.length).split('/').filter((part) => part.length > 0);
  if (key.endsWith('/')) parts.pop();
  parts.pop();
  return parts.length ? parts.join('/') : null;
}

/** Relative folder path safe to pass back into list_my_files, or null if it is not this user's. */
export function relativeFolder(prefix, userId) {
  const base = userPrefix(userId);
  if (typeof prefix !== 'string' || !prefix.startsWith(base)) return null;
  const rel = prefix.slice(base.length).replace(/\/$/, '');
  return rel || null;
}

async function defaultHeadObject(userId, key) {
  if (!isKeyAllowed(key, userId)) return null;
  const bucket = config.aws?.bucketName;
  if (!bucket) return null;
  try {
    const res = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return res?.Metadata ?? null;
  } catch {
    return null;
  }
}

export function filesDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    listObjects: deps.listObjects ?? realListObjects,
    getDownloadUrl: deps.getDownloadUrl ?? realGetDownloadUrl,
    headObject: deps.headObject ?? defaultHeadObject,
  };
}

function byRecent(a, b) {
  if (!a.lastModified && !b.lastModified) return 0;
  if (!a.lastModified) return 1;
  if (!b.lastModified) return -1;
  return a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0;
}

export async function mapListedFile(file, userId, headObject) {
  const key = file?.key;
  if (typeof key !== 'string' || !key || key.endsWith('/')) return null;
  if (!isKeyAllowed(key, userId)) return null;
  const leaf = key.split('/').pop() || '';
  const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : (leaf || null);
  if (!name) return null;

  let metadata = null;
  if (typeof headObject === 'function') {
    try {
      metadata = await headObject(userId, key);
    } catch {
      metadata = null;
    }
  }

  return {
    key,
    name,
    originalName: originalNameFromMetadata(metadata),
    folder: folderOf(key, userId),
    size: file.size == null ? null : file.size,
    lastModified: file.lastModified || null,
    uploadedBy: uploadedByFromMetadata(metadata),
  };
}

export function mapListedFolder(folder, userId) {
  const prefix = folder?.prefix;
  if (typeof prefix !== 'string' || !prefix.startsWith(userPrefix(userId))) return null;
  if (!isKeyAllowed(prefix, userId)) return null;
  const folderPath = relativeFolder(prefix, userId);
  const name = typeof folder?.name === 'string' && folder.name.trim()
    ? folder.name.trim()
    : (folderPath ? folderPath.split('/').pop() : null);
  if (!name) return null;
  return { name, folder: folderPath };
}

export async function toFileList(result, userId, headObject) {
  const files = [];
  for (const file of result?.files || []) {
    // Sequential on purpose: headObject is already one round trip each, and a thrown head
    // must not drop the rest of the page. LIST_LIMIT caps how many run.
    // eslint-disable-next-line no-await-in-loop
    const row = await mapListedFile(file, userId, headObject);
    if (row) files.push(row);
  }
  files.sort(byRecent);

  const folders = [];
  for (const folder of result?.folders || []) {
    const row = mapListedFolder(folder, userId);
    if (row) folders.push(row);
  }

  return { files, folders };
}
