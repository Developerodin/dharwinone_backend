import test from 'node:test';
import assert from 'node:assert/strict';
import { REFERRAL_LEADS_EXPORT_HEADERS } from '../../utils/referralLeadsExcel.service.js';

test('export headers include sales agent columns and a single Status column', () => {
  assert.match(
    REFERRAL_LEADS_EXPORT_HEADERS.join(','),
    /Assigned Sales Agent Name,Assigned Sales Agent Email,Joining Date,Claimed At \(UTC\)/
  );
  assert.equal(REFERRAL_LEADS_EXPORT_HEADERS.filter((h) => h === 'Status').length, 1);
  assert.ok(!REFERRAL_LEADS_EXPORT_HEADERS.includes('lifecycle_stage'));
});
