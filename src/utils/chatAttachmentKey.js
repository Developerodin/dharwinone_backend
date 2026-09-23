import httpStatus from 'http-status';
import ApiError from './ApiError.js';
import { isKeyAllowed } from '../services/fileStorage.service.js';

/**
 * Folders under which uploadFileToS3 writes `<folder>/<userId>/<file>`: the chat upload route and
 * the generic POST /upload route (default folder) that clients use before sending a message.
 */
const OWN_UPLOAD_FOLDERS = ['chat-attachments', 'documents'];

/**
 * An attachment `key` is presigned against the shared bucket on every read, so a client may only
 * reference an object it uploaded itself: its own file-storage prefix (the existing
 * fileStorage allow-check) or its own chat/generic upload prefix. An empty key is a URL-only
 * attachment and is fine — the URL itself is restricted to http(s) by the Joi schema.
 */
const isChatAttachmentKeyAllowed = (key, userId) => {
  if (key == null || key === '') return true;
  if (typeof key !== 'string' || !userId) return false;
  if (isKeyAllowed(key, String(userId))) return true;
  return OWN_UPLOAD_FOLDERS.some((folder) => {
    const prefix = `${folder}/${userId}/`;
    if (!key.startsWith(prefix)) return false;
    const suffix = key.slice(prefix.length);
    return Boolean(suffix) && !suffix.includes('..') && !suffix.includes('\\') && !/%2e|%2f|%5c/i.test(suffix);
  });
};

/** Throws 400 when any client-supplied attachment key points outside the sender's own uploads. */
const assertChatAttachmentKeysAllowed = (attachments, userId) => {
  for (const a of attachments || []) {
    if (!isChatAttachmentKeyAllowed(a?.key, userId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Attachment key is not allowed');
    }
  }
};

export { isChatAttachmentKeyAllowed, assertChatAttachmentKeysAllowed };
