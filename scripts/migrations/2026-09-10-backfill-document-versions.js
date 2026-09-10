/**
 * Backfill `documents[].logicalSlot` / `documents[].slotVersion` and `documentVersions[]`
 * for existing resume + cover-letter uploads.
 *
 * Why this is needed:
 * - Historical rows only had label/type semantics (e.g. "CV/Resume") with no stable slot key.
 * - New version-aware APIs require slot-based history (`resume`, `cover-letter`) and version ids.
 *
 * Idempotent:
 * - Running repeatedly does not duplicate `documentVersions` rows for the same file identity.
 * - Existing slot/version values are preserved when valid.
 *
 * Usage:
 *   node scripts/migrations/2026-09-10-backfill-document-versions.js          # dry-run
 *   node scripts/migrations/2026-09-10-backfill-document-versions.js --apply
 */
/* eslint-disable no-console */
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();
const APPLY = process.argv.includes('--apply');

const SLOTS = /** @type {const} */ (['resume', 'cover-letter']);

/**
 * @param {unknown} raw
 * @returns {'resume'|'cover-letter'|null}
 */
export function normalizeSlot(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'resume' || v === 'cv/resume' || v === 'cv' || v === 'curriculum vitae') return 'resume';
  if (v === 'cover-letter' || v === 'cover letter') return 'cover-letter';
  return null;
}

/**
 * @param {Record<string, unknown>} doc
 * @returns {'resume'|'cover-letter'|null}
 */
export function inferSlotFromDocument(doc = {}) {
  const explicit = normalizeSlot(doc.logicalSlot);
  if (explicit) return explicit;
  const text = [doc.type, doc.label, doc.originalName]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!text) return null;
  if (
    text.includes('cv/resume')
    || text.includes('resume')
    || text.includes('curriculum vitae')
    || text === 'cv'
  ) {
    return 'resume';
  }
  if (text.includes('cover letter') || text.includes('cover-letter')) return 'cover-letter';
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function fileIdentity(row = {}) {
  const key = String(row.key || '').trim();
  if (key) return `key:${key}`;
  const url = String(row.documentUrl || row.url || '').trim();
  if (url) return `url:${url}`;
  const name = String(row.originalName || row.label || '').trim();
  if (name) return `name:${name}`;
  return '';
}

/**
 * @param {Record<string, unknown>} doc
 * @param {'resume'|'cover-letter'} slot
 * @param {number} version
 * @returns {Record<string, unknown>}
 */
function versionRowFromDocument(doc, slot, version) {
  return {
    slot,
    version,
    type: String(doc.type || (slot === 'resume' ? 'CV/Resume' : 'Other')).trim(),
    label: String(doc.label || (slot === 'resume' ? 'Resume' : 'Cover Letter')).trim(),
    documentUrl: String(doc.documentUrl || doc.url || '').trim() || undefined,
    key: String(doc.key || '').trim() || undefined,
    originalName: String(doc.originalName || '').trim() || undefined,
    size: Number.isFinite(Number(doc.size)) ? Number(doc.size) : undefined,
    mimeType: String(doc.mimeType || '').trim() || undefined,
    createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
    createdBy: doc.createdBy || undefined,
  };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {'resume'|'cover-letter'} slot
 * @returns {number}
 */
function maxVersionForSlot(rows, slot) {
  let max = 0;
  for (const row of rows) {
    if (normalizeSlot(row?.slot) !== slot) continue;
    const v = Number(row?.version);
    if (Number.isInteger(v) && v > max) max = v;
  }
  return max;
}

/**
 * @param {Record<string, unknown>} candidate
 * @returns {{ needsUpdate: boolean, documents: Array<Record<string, unknown>>, documentVersions: Array<Record<string, unknown>>, addedVersions: number }}
 */
export function buildBackfillPlan(candidate = {}) {
  const docs = Array.isArray(candidate.documents) ? candidate.documents.map((d) => ({ ...(d || {}) })) : [];
  const versions = Array.isArray(candidate.documentVersions)
    ? candidate.documentVersions.map((v) => ({ ...(v || {}) }))
    : [];
  const identities = new Map();
  for (const slot of SLOTS) {
    identities.set(slot, new Map());
  }
  for (const row of versions) {
    const slot = normalizeSlot(row.slot);
    if (!slot) continue;
    const id = fileIdentity(row);
    if (!id) continue;
    const v = Number(row.version);
    if (Number.isInteger(v) && v > 0) identities.get(slot).set(id, v);
  }

  let addedVersions = 0;
  let changed = false;

  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    const slot = inferSlotFromDocument(doc);
    if (!slot) continue;

    if (normalizeSlot(doc.logicalSlot) !== slot) {
      doc.logicalSlot = slot;
      changed = true;
    }

    const id = fileIdentity(doc);
    let versionNumber =
      Number.isInteger(Number(doc.slotVersion)) && Number(doc.slotVersion) > 0
        ? Number(doc.slotVersion)
        : null;

    if (id && identities.get(slot).has(id)) {
      const existingVersion = identities.get(slot).get(id);
      if (versionNumber == null || versionNumber !== existingVersion) {
        versionNumber = existingVersion;
      }
    } else {
      const next = maxVersionForSlot(versions, slot) + 1;
      const versionRow = versionRowFromDocument(doc, slot, next);
      versions.push(versionRow);
      if (id) identities.get(slot).set(id, next);
      versionNumber = next;
      addedVersions += 1;
      changed = true;
    }

    if (versionNumber != null && Number(doc.slotVersion) !== versionNumber) {
      doc.slotVersion = versionNumber;
      changed = true;
    }
  }

  return {
    needsUpdate: changed,
    documents: docs,
    documentVersions: versions,
    addedVersions,
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);
  const candidates = mongoose.connection.db.collection('candidates');

  const rows = await candidates
    .find({
      documents: { $exists: true, $ne: [] },
    })
    .project({ documents: 1, documentVersions: 1 })
    .toArray();

  let targets = 0;
  let totalAddedVersions = 0;
  const updates = [];

  for (const row of rows) {
    const plan = buildBackfillPlan(row);
    if (!plan.needsUpdate) continue;
    targets += 1;
    totalAddedVersions += plan.addedVersions;
    updates.push({ _id: row._id, plan });
  }

  console.log(`${targets} candidate(s) need document slot/version backfill`);
  console.log(`${totalAddedVersions} document version row(s) will be added`);

  if (!APPLY) {
    console.log('Dry run — pass --apply to write.');
    await mongoose.disconnect();
    return;
  }

  let modified = 0;
  for (const { _id, plan } of updates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await candidates.updateOne(
      { _id },
      {
        $set: {
          documents: plan.documents,
          documentVersions: plan.documentVersions,
        },
      }
    );
    modified += res.modifiedCount;
  }

  console.log(`Updated ${modified} candidate(s).`);
  await mongoose.disconnect();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
