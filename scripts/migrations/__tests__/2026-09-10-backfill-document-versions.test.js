import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSlot,
  inferSlotFromDocument,
  buildBackfillPlan,
} from '../2026-09-10-backfill-document-versions.js';

test('normalizeSlot supports historical aliases', () => {
  assert.equal(normalizeSlot('resume'), 'resume');
  assert.equal(normalizeSlot('CV/Resume'), 'resume');
  assert.equal(normalizeSlot('cover letter'), 'cover-letter');
  assert.equal(normalizeSlot('other'), null);
});

test('inferSlotFromDocument resolves by logicalSlot, type, and label', () => {
  assert.equal(inferSlotFromDocument({ logicalSlot: 'resume' }), 'resume');
  assert.equal(inferSlotFromDocument({ type: 'CV/Resume' }), 'resume');
  assert.equal(inferSlotFromDocument({ label: 'Cover Letter' }), 'cover-letter');
  assert.equal(inferSlotFromDocument({ type: 'Passport' }), null);
});

test('buildBackfillPlan creates versions and slotVersion for legacy resume docs', () => {
  const plan = buildBackfillPlan({
    documents: [
      { type: 'CV/Resume', label: 'Resume', key: 'resume-v1', originalName: 'resume-v1.pdf' },
      { type: 'CV/Resume', label: 'Resume', key: 'resume-v2', originalName: 'resume-v2.pdf' },
    ],
  });

  assert.equal(plan.needsUpdate, true);
  assert.equal(plan.addedVersions, 2);
  assert.equal(plan.documentVersions.length, 2);
  assert.deepEqual(
    plan.documents.map((d) => ({ logicalSlot: d.logicalSlot, slotVersion: d.slotVersion })),
    [
      { logicalSlot: 'resume', slotVersion: 1 },
      { logicalSlot: 'resume', slotVersion: 2 },
    ]
  );
});

test('buildBackfillPlan is idempotent when rerun', () => {
  const first = buildBackfillPlan({
    documents: [{ type: 'CV/Resume', label: 'Resume', key: 'resume-v1', originalName: 'resume-v1.pdf' }],
  });

  const second = buildBackfillPlan({
    documents: first.documents,
    documentVersions: first.documentVersions,
  });

  assert.equal(second.needsUpdate, false);
  assert.equal(second.addedVersions, 0);
});

test('buildBackfillPlan reuses existing version row identity', () => {
  const plan = buildBackfillPlan({
    documents: [{ type: 'CV/Resume', label: 'Resume', key: 'resume-v1', originalName: 'resume-v1.pdf' }],
    documentVersions: [{ slot: 'resume', version: 4, key: 'resume-v1', originalName: 'resume-v1.pdf' }],
  });

  assert.equal(plan.needsUpdate, true);
  assert.equal(plan.addedVersions, 0);
  assert.equal(plan.documents[0].slotVersion, 4);
  assert.equal(plan.documentVersions.length, 1);
});
