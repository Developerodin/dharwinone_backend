/**
 * WhatsApp-style preview copy for chat attachment messages (push, list, in-app).
 */

const GENERIC_PLACEHOLDERS = new Set([
  'attaching file',
  '📷 image',
  '📎 file',
  '🎤 voice note',
  'image',
  'file',
  'audio',
  'video',
  'attachment',
]);

export function isGenericAttachmentPlaceholder(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return true;
  return GENERIC_PLACEHOLDERS.has(trimmed.toLowerCase());
}

export function documentTypeLabel(filename = '', mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();

  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'PDF';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    return 'DOCX';
  }
  if (mime === 'application/msword' || name.endsWith('.doc')) return 'DOC';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    name.endsWith('.xlsx')
  ) {
    return 'XLSX';
  }
  if (mime === 'application/vnd.ms-excel' || name.endsWith('.xls')) return 'XLS';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    name.endsWith('.pptx')
  ) {
    return 'PPTX';
  }
  if (mime.includes('presentation') || name.endsWith('.ppt')) return 'PPT';
  if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.csv')) {
    if (name.endsWith('.csv')) return 'CSV';
    return 'TXT';
  }
  if (mime.includes('zip') || name.endsWith('.zip')) return 'ZIP';
  return '';
}

function truncateFilename(name, max = 42) {
  const raw = String(name || 'document').trim() || 'document';
  if (raw.length <= max) return raw;
  const extMatch = raw.match(/(\.[a-z0-9]{1,8})$/i);
  const ext = extMatch ? extMatch[1] : '';
  const base = ext ? raw.slice(0, -ext.length) : raw;
  const keep = Math.max(8, max - ext.length - 1);
  return `${base.slice(0, keep)}…${ext}`;
}

function isVoiceLike(mimeType = '', filename = '') {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  if (/voice|voicenote|audio-message|recording/.test(name)) return true;
  return (
    mime.includes('ogg') ||
    mime.includes('opus') ||
    mime === 'audio/mp4' ||
    mime === 'audio/m4a' ||
    mime === 'audio/aac' ||
    mime === 'audio/x-m4a' ||
    mime === 'audio/webm'
  );
}

function inferKind(type, attachments = []) {
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'file') return type;
  const mime = String(attachments[0]?.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (attachments.length) return 'file';
  return 'text';
}

/**
 * Build human-readable preview for a chat message.
 * Prefers a real caption when present; otherwise type-aware attachment copy.
 *
 * @param {{ content?: string, type?: string, attachments?: Array<{ originalName?: string, mimeType?: string, url?: string }> }} message
 * @returns {{ text: string, kind: string, imageUrl?: string, attachmentName?: string, documentType?: string }}
 */
export function buildChatMessagePreview(message = {}) {
  if (message.deletedAt && message.deletedFor === 'everyone') {
    return { text: 'This message was deleted', kind: 'text' };
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const kind = inferKind(message.type, attachments);
  const rawContent = String(message.content || '').trim();
  const hasRealCaption = rawContent && !isGenericAttachmentPlaceholder(rawContent);
  const first = attachments[0] || {};
  const filename = first.originalName || first.name || 'document';
  const mimeType = first.mimeType || '';
  const count = attachments.length || 1;

  if (kind === 'text') {
    return { text: rawContent.slice(0, 120) || 'New message', kind };
  }

  // Caption sent with media — keep it as the notification body (WhatsApp-like).
  if (hasRealCaption) {
    return {
      text: rawContent.slice(0, 120),
      kind,
      imageUrl: kind === 'image' && first.url ? first.url : undefined,
      attachmentName: filename,
      documentType: kind === 'file' ? documentTypeLabel(filename, mimeType) : undefined,
    };
  }

  if (kind === 'image') {
    return {
      text: count > 1 ? `Sent ${count} photos` : 'Sent a photo',
      kind,
      imageUrl: first.url || undefined,
      attachmentName: filename,
    };
  }

  if (kind === 'video') {
    return {
      text: count > 1 ? `Sent ${count} videos` : 'Sent a video',
      kind,
      // Expo richContent only accepts image URLs; video thumbnail generation is out of scope.
      attachmentName: filename,
    };
  }

  if (kind === 'audio') {
    const voice = isVoiceLike(mimeType, filename);
    return {
      text: voice ? 'Sent a voice message' : 'Sent an audio file',
      kind,
      attachmentName: filename,
    };
  }

  // Documents / other files
  if (count > 1) {
    return {
      text: `Sent ${count} documents`,
      kind: 'file',
      attachmentName: filename,
    };
  }

  const docType = documentTypeLabel(filename, mimeType);
  const truncated = truncateFilename(filename);
  return {
    text: docType ? `📄 ${truncated} · ${docType}` : `📄 ${truncated}`,
    kind: 'file',
    attachmentName: filename,
    documentType: docType || undefined,
  };
}

/** Stored message content when client sends empty / generic placeholder. */
export function defaultAttachmentContent(type, attachments = []) {
  return buildChatMessagePreview({ type, attachments, content: '' }).text;
}
