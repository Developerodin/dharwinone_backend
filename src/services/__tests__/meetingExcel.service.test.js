import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { buildMeetingsExportBuffer } from '../meetingExcel.service.js';

const meetings = [
  {
    title: 'M1',
    candidate: { name: 'John Anderson', email: 'john.anderson@example.com', phone: '9876543210' },
    recruiter: { name: 'Sarah Johnson', email: 'sarah.johnson@example.com' },
    jobPosition: 'backend-engineer',
    interviewType: 'Video',
    scheduledAt: '2026-02-01T10:00:00.000Z',
    durationMinutes: 60,
    status: 'ended',
    interviewResult: 'pending',
    createdAt: '2026-01-20T09:00:00.000Z',
    publicMeetingUrl: 'https://dharwinone.com/join/room?room=meeting_abc',
  },
];

// Note: XLSX.read does not reconstruct !cols on parse, so column widths are
// asserted at the raw-XML level rather than here. The core regression this
// guards is the header offset (was pushed to row 3 by a banner/blank row).
test('header is on row 1, data aligned to columns, autofilter over full range', () => {
  const wb = XLSX.read(buildMeetingsExportBuffer(meetings), { type: 'buffer' });
  const ws = wb.Sheets.Interviews;

  assert.equal(ws.A1.v, 'Title');
  assert.equal(ws.B1.v, 'Candidate Name');
  assert.equal(ws.N1.v, 'Meeting Link');
  assert.equal(ws.A2.v, 'M1');
  assert.equal(ws.B2.v, 'John Anderson');
  assert.equal(ws['!autofilter'].ref, 'A1:N2');
});
