import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import {
  DOCUMENT_VERSION_SLOTS,
  latestVersionForSlot,
  findLatestSlotDocumentIndex,
  normalizeVersionSlot,
} from '../utils/documentVersionSlot.js';

// ponytail: file is still named ...ResumeSnapshot because every importer does; it now serves
// both versioned slots. Rename it only if a third consumer appears.

/** Human label per slot, used in the "version N not found" error. */
const SLOT_LABELS = {
  [DOCUMENT_VERSION_SLOTS.RESUME]: 'Resume',
  [DOCUMENT_VERSION_SLOTS.COVER_LETTER]: 'Cover letter',
};

const buildSubmittedFileFromRow = (slot, row) => ({
  slot,
  version: Number(row.version) || 1,
  key: String(row.key || '').trim() || undefined,
  documentUrl: String(row.documentUrl || row.url || '').trim() || undefined,
  originalName: String(row.originalName || row.label || '').trim() || undefined,
  mimeType: row.mimeType ? String(row.mimeType).trim() : undefined,
  size: typeof row.size === 'number' && row.size >= 0 ? row.size : undefined,
  capturedAt: new Date(),
});

const resolveSlotVersionRow = (candidate, slot, explicitVersion) => {
  const label = SLOT_LABELS[slot] || 'Document';
  if (explicitVersion != null) {
    const versionNumber = Number(explicitVersion);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid ${label.toLowerCase()} version`);
    }
    const row = (candidate.documentVersions || []).find(
      (v) => normalizeVersionSlot(v?.slot) === slot && Number(v.version) === versionNumber
    );
    if (!row) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${label} version ${versionNumber} not found`);
    }
    return row;
  }

  const latest = latestVersionForSlot(candidate.documentVersions || [], slot);
  if (latest) return latest;

  const idx = findLatestSlotDocumentIndex(candidate.documents || [], slot);
  if (idx < 0) return null;
  const doc = candidate.documents[idx];
  const docObj = doc?.toObject ? doc.toObject() : doc;
  return {
    slot,
    version: Number.isFinite(Number(docObj?.slotVersion)) ? Number(docObj.slotVersion) : 1,
    key: docObj?.key,
    documentUrl: docObj?.url || docObj?.documentUrl,
    originalName: docObj?.originalName || docObj?.label,
    mimeType: docObj?.mimeType,
    size: docObj?.size,
  };
};

/**
 * Immutable file snapshot for a job application (read-only; upload before calling).
 * @param {import('mongoose').Document} candidate
 * @param {string} slot - a DOCUMENT_VERSION_SLOTS value
 * @param {{ version?: number }} [options]
 * @returns {Promise<object|undefined>}
 */
const captureSlotSnapshot = async (candidate, slot, options = {}) => {
  if (!candidate?._id) return undefined;

  const row = resolveSlotVersionRow(candidate, slot, options.version);
  if (!row) return undefined;
  return buildSubmittedFileFromRow(slot, row);
};

const captureResumeSnapshot = async (candidate, options = {}) =>
  captureSlotSnapshot(candidate, DOCUMENT_VERSION_SLOTS.RESUME, options);

const resolveResumeVersionRow = (candidate, explicitVersion) =>
  resolveSlotVersionRow(candidate, DOCUMENT_VERSION_SLOTS.RESUME, explicitVersion);

const buildSubmittedResumeFromRow = (slot, row) => buildSubmittedFileFromRow(slot, row);

export {
  captureSlotSnapshot,
  resolveSlotVersionRow,
  buildSubmittedFileFromRow,
  captureResumeSnapshot,
  resolveResumeVersionRow,
  buildSubmittedResumeFromRow,
};
