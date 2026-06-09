import test from 'node:test';
import assert from 'node:assert/strict';
import { getGrantingPermissions } from '../../config/permissions.js';

const ORG_KEYS = [
  'chart.read',
  'structure.read',
  'structure.manage',
  'structure.export',
  'departments.read',
  'departments.manage',
];

const ATS_GRANT_PREFIXES = ['candidates.', 'jobs.', 'recruiters.', 'offers.', 'interviews.'];

test('structure/chart/departments keys are not ATS-aliased', () => {
  for (const key of ORG_KEYS) {
    const grants = getGrantingPermissions(key);
    assert.ok(grants.includes(key), `${key} should grant itself`);
    for (const g of grants) {
      assert.ok(
        !ATS_GRANT_PREFIXES.some((p) => g.startsWith(p)),
        `${key} must not alias to ATS permission ${g}`
      );
    }
  }
});
