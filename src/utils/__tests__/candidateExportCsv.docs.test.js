import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidateExportCsv } from '../candidateExportCsv.js';

test('Documents CSV cell includes label and type only', () => {
  const csv = generateCandidateExportCsv({
    totalCandidates: 1,
    exportedAt: '2026-06-12T00:00:00.000Z',
    data: [{
      fullName: 'Asha',
      documents: [
        { label: 'Aadhar Card', type: 'Aadhar', url: 'https://x/a.pdf', status: 1 },
        { label: '', originalName: 'pan.pdf', type: 'PAN', url: '', status: 2 },
      ],
    }],
  });
  const docCol = csv.split('\n')[1];
  assert.match(docCol, /Aadhar Card \[Aadhar\]/);
  assert.match(docCol, /pan\.pdf \[PAN\]/);
  assert.doesNotMatch(docCol, /Approved|Rejected|Pending/);
});
