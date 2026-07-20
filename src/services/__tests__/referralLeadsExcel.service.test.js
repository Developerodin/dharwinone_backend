import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {
  REFERRAL_LEADS_EXPORT_HEADERS,
  buildReferralLeadsExportBuffer,
} from '../../utils/referralLeadsExcel.service.js';

test('export headers match ATS table columns (single Status, no internal ids)', () => {
  assert.deepEqual(REFERRAL_LEADS_EXPORT_HEADERS, [
    'Candidate Name',
    'Candidate Email',
    'Referred By Name',
    'Referred By Email',
    'Link Type',
    'Job Title',
    'Status',
    'Assigned Sales Agent Name',
    'Assigned Sales Agent Email',
    'Joining Date',
    'Claimed At (UTC)',
  ]);
  const statusCount = REFERRAL_LEADS_EXPORT_HEADERS.filter((h) => h === 'Status').length;
  assert.equal(statusCount, 1);
  assert.ok(!REFERRAL_LEADS_EXPORT_HEADERS.some((h) => /referral_jti|candidate_id|org_id|lifecycle/i.test(h)));
});

test('buildReferralLeadsExportBuffer produces xlsx with shaped row values', () => {
  const buf = buildReferralLeadsExportBuffer([
    {
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      referredBy: { name: 'Referrer One', email: 'ref@example.com' },
      referralContext: 'JOB_APPLY',
      job: { title: 'Engineer' },
      referralPipelineStatus: 'applied',
      salesAgent: { name: 'Agent Smith', email: 'agent@example.com' },
      joiningDate: '2026-01-15T00:00:00.000Z',
      referredAt: '2026-01-01T12:00:00.000Z',
    },
  ]);
  assert.ok(Buffer.isBuffer(buf));
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets['Referral Leads'];
  assert.ok(sheet);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.equal(rows[0][0], 'Candidate Name');
  assert.equal(rows[1][0], 'Jane Doe');
  assert.equal(rows[1][4], 'Job link');
  assert.equal(rows[1][6], 'Applied');
  assert.equal(rows[1][7], 'Agent Smith');
});
