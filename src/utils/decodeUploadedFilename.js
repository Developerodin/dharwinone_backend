/**
 * Multipart uploads from React Native often send URL-encoded filenames
 * (e.g. "My%20Document.pdf"). Decode for display/storage without altering
 * the bytes or S3 object key (keys are generated independently).
 */
export function decodeUploadedFilename(name) {
  if (name == null) return '';
  const trimmed = String(name).trim();
  if (!trimmed) return trimmed;
  if (!/%[0-9A-Fa-f]{2}/.test(trimmed) && !trimmed.includes('+')) {
    return trimmed;
  }
  try {
    return decodeURIComponent(trimmed.replace(/\+/g, ' '));
  } catch {
    return trimmed;
  }
}
