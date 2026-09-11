/**
 * Resume / cover-letter slot resolution.
 *
 * These rules are duplicated in the frontend
 * (`shared/components/candidates/VersionedDocumentSlot.tsx` → `inferDocumentVersionSlot`).
 * The two MUST agree: when the frontend called a row "the resume" and the backend did not,
 * `findLatestSlotDocumentIndex` returned -1 and the version upsert appended a second resume
 * row instead of replacing the existing one. Keep both in step, and keep the test beside this
 * file green.
 */

const DOCUMENT_VERSION_SLOTS = Object.freeze({
  RESUME: 'resume',
  COVER_LETTER: 'cover-letter',
});

const DOCUMENT_VERSION_SLOT_VALUES = Object.freeze(Object.values(DOCUMENT_VERSION_SLOTS));

const normalizeVersionSlot = (raw) => {
  if (raw == null) return null;
  const slot = String(raw).trim().toLowerCase();
  if (!slot) return null;
  if (slot === 'resume' || slot === 'cv' || slot === 'cv/resume') return DOCUMENT_VERSION_SLOTS.RESUME;
  if (slot === 'cover-letter' || slot === 'cover_letter' || slot === 'coverletter' || slot === 'cover letter') {
    return DOCUMENT_VERSION_SLOTS.COVER_LETTER;
  }
  return null;
};

/**
 * Resolve which slot a `documents[]` row belongs to.
 *
 * Order matters: explicit stamp, then `type`, then `label`. The label fallback exists because
 * `GET /employees/documents/:candidateId` did not return `type`, so a row round-tripped through
 * the employee edit form came back carrying only its label and stopped resolving to a slot.
 */
const inferVersionSlotFromDocument = (doc) => {
  if (!doc || typeof doc !== 'object') return null;
  const explicit = normalizeVersionSlot(doc.logicalSlot);
  if (explicit) return explicit;

  const type = String(doc.type || '').trim().toLowerCase();
  if (type === 'cv/resume' || type === 'resume' || type === 'cv') return DOCUMENT_VERSION_SLOTS.RESUME;
  if (type === 'cover letter') return DOCUMENT_VERSION_SLOTS.COVER_LETTER;

  const label = String(doc.label || '').trim().toLowerCase();
  if (label === 'cv/resume' || label === 'resume' || label === 'cv') return DOCUMENT_VERSION_SLOTS.RESUME;
  if (label === 'cover letter' || label === 'cover-letter' || label === 'coverletter') {
    return DOCUMENT_VERSION_SLOTS.COVER_LETTER;
  }
  return null;
};

const canonicalDocumentDefaultsForSlot = (slot) =>
  slot === DOCUMENT_VERSION_SLOTS.RESUME
    ? { type: 'CV/Resume', label: 'CV/Resume' }
    : { type: 'Other', label: 'Cover Letter' };

/** Normalize an upload/document row down to the file fields a version row stores. */
const normalizeVersionPayloadFile = (row = {}) => {
  const key = String(row.key || '').trim();
  const documentUrl = String(row.documentUrl || row.url || '').trim();
  if (!key && !documentUrl) return null;
  const originalName = String(row.originalName || row.fileName || '').trim();
  const size = Number(row.size);
  return {
    key: key || '',
    documentUrl: documentUrl || '',
    originalName,
    size: Number.isFinite(size) && size >= 0 ? size : undefined,
    mimeType: row.mimeType ? String(row.mimeType).trim() : undefined,
  };
};

/** Identity used to decide "is this the same file as the current version?" — S3 key when present. */
const versionFileIdentity = (row = {}) => {
  const key = String(row.key || '').trim();
  if (key) return `key:${key}`;
  const url = String(row.documentUrl || row.url || '').trim();
  const name = String(row.originalName || row.fileName || '').trim();
  return `url:${url}|name:${name}`;
};

const latestVersionForSlot = (documentVersions = [], slot) => {
  let latest = null;
  for (const row of documentVersions || []) {
    if (normalizeVersionSlot(row?.slot) !== slot) continue;
    if (!latest || Number(row.version) > Number(latest.version)) latest = row;
  }
  return latest;
};

const nextVersionForSlot = (documentVersions = [], slot) => {
  const latest = latestVersionForSlot(documentVersions, slot);
  return latest ? Number(latest.version) + 1 : 1;
};

/** Index of the row that currently represents `slot`. Last match wins — legacy profiles can hold more than one. */
const findLatestSlotDocumentIndex = (documents = [], slot) => {
  for (let i = (documents || []).length - 1; i >= 0; i -= 1) {
    if (inferVersionSlotFromDocument(documents[i]) === slot) return i;
  }
  return -1;
};

const VERSIONED_SLOT_GENERIC_UPLOAD_MESSAGE =
  'Resume and cover letter must be uploaded via the dedicated Resume / Cover Letter cards (versioned document endpoints).';

/**
 * Detect generic-path uploads that resolve to a versioned slot on existing candidates.
 * Allows legacy rows echoed back without `logicalSlot` when the S3 key is unchanged.
 * Returns an error message when a bypass is detected, otherwise null.
 */
const findGenericVersionedSlotBypass = (existingDocs = [], incomingDocs = []) => {
  if (!Array.isArray(incomingDocs) || incomingDocs.length === 0) return null;
  const existing = (existingDocs || []).map((d) => (d?.toObject ? d.toObject() : d));

  for (const raw of incomingDocs) {
    const doc = raw?.toObject ? raw.toObject() : raw;
    if (!doc || doc.logicalSlot) continue;

    const slot = inferVersionSlotFromDocument(doc);
    if (!slot) continue;

    const key = String(doc.key || '').trim();
    const idx = findLatestSlotDocumentIndex(existing, slot);
    const existingSlotDoc = idx >= 0 ? existing[idx] : null;
    const existingKey = String(existingSlotDoc?.key || '').trim();

    if (key && existingKey && key === existingKey) continue;

    return VERSIONED_SLOT_GENERIC_UPLOAD_MESSAGE;
  }
  return null;
};

export {
  DOCUMENT_VERSION_SLOTS,
  DOCUMENT_VERSION_SLOT_VALUES,
  normalizeVersionSlot,
  inferVersionSlotFromDocument,
  canonicalDocumentDefaultsForSlot,
  normalizeVersionPayloadFile,
  versionFileIdentity,
  latestVersionForSlot,
  nextVersionForSlot,
  findLatestSlotDocumentIndex,
  VERSIONED_SLOT_GENERIC_UPLOAD_MESSAGE,
  findGenericVersionedSlotBypass,
};
