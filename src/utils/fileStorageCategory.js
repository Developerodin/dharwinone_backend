import httpStatus from 'http-status';
import ApiError from './ApiError.js';

export const CATEGORY_MISMATCH_MESSAGE =
  'This file type cannot be uploaded to the selected category. Please select the appropriate folder.';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'tif', 'tiff']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv', '3gp']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'wma', 'opus', 'aiff']);
const DOC_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'txt',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'rtf',
  'html',
  'htm',
  'xml',
  'json',
  'odt',
  'ods',
  'odp',
]);
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2']);

/** Built-in category folders. `downloads` is a general/default folder and accepts any allowed type. */
export const CATEGORY_EXTENSIONS = {
  images: IMAGE_EXTS,
  videos: VIDEO_EXTS,
  music: AUDIO_EXTS,
  docs: DOC_EXTS,
  archives: ARCHIVE_EXTS,
  downloads: null,
};

const FOLDER_SEGMENT_TO_CATEGORY = {
  images: 'images',
  image: 'images',
  videos: 'videos',
  video: 'videos',
  docs: 'docs',
  documents: 'docs',
  music: 'music',
  downloads: 'downloads',
  archives: 'archives',
};

export function fileExtension(name) {
  if (!name || typeof name !== 'string') return '';
  const base = name.split(/[/\\]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Map a folder path (e.g. `Images/`, `Documents/reports/`) to a built-in category id.
 * Custom folders return null and are not type-restricted.
 */
export function categoryIdFromFolderPath(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') return null;
  const segment = folderPath
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .find(Boolean);
  return segment ? FOLDER_SEGMENT_TO_CATEGORY[segment] ?? null : null;
}

export function fileMatchesCategory(fileName, folderPath) {
  const categoryId = categoryIdFromFolderPath(folderPath);
  if (!categoryId) return true;
  const allowed = CATEGORY_EXTENSIONS[categoryId];
  if (!allowed) return true;
  return allowed.has(fileExtension(fileName));
}

export function assertFileMatchesCategory(file, folderPath) {
  const name = file?.originalname || file?.name || '';
  if (!fileMatchesCategory(name, folderPath)) {
    throw new ApiError(httpStatus.BAD_REQUEST, CATEGORY_MISMATCH_MESSAGE);
  }
}
