import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import {
  DOCUMENT_VERSION_SLOTS,
  latestVersionForSlot,
  findLatestSlotDocumentIndex,
  normalizeVersionSlot,
} from '../utils/documentVersionSlot.js';

const buildSubmittedResumeFromRow = (slot, row) => ({
  slot,
  version: Number(row.version) || 1,
  key: String(row.key || '').trim() || undefined,
  documentUrl: String(row.documentUrl || row.url || '').trim() || undefined,
  originalName: String(row.originalName || row.label || '').trim() || undefined,
  mimeType: row.mimeType ? String(row.mimeType).trim() : undefined,
  size: typeof row.size === 'number' && row.size >= 0 ? row.size : undefined,
  capturedAt: new Date(),
});

const resolveResumeVersionRow = (candidate, explicitVersion) => {
  const slot = DOCUMENT_VERSION_SLOTS.RESUME;
  if (explicitVersion != null) {
    const versionNumber = Number(explicitVersion);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid resume version');
    }
    const row = (candidate.documentVersions || []).find(
      (v) => normalizeVersionSlot(v?.slot) === slot && Number(v.version) === versionNumber
    );
    if (!row) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Resume version ${versionNumber} not found`);
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
 * Immutable resume snapshot for a job application (read-only; upload before calling).
 * @param {import('mongoose').Document} candidate
 * @param {{ version?: number }} [options]
 * @returns {Promise<object|undefined>}
 */
const captureResumeSnapshot = async (candidate, options = {}) => {
  if (!candidate?._id) return undefined;

  const { version } = options;
  const slot = DOCUMENT_VERSION_SLOTS.RESUME;
  const row = resolveResumeVersionRow(candidate, version);
  if (!row) return undefined;
  return buildSubmittedResumeFromRow(slot, row);
};

export { captureResumeSnapshot, resolveResumeVersionRow, buildSubmittedResumeFromRow };
