import test from 'node:test';
import assert from 'node:assert/strict';
import { getGrantingPermissions } from '../../config/permissions.js';

test('structure/chart/departments keys are not ATS-aliased', () => {
  for (const key of ['chart.read', 'structure.read', 'structure.manage', 'departments.read', 'departments.manage']) {
    assert.deepEqual(getGrantingPermissions(key), [key]);
  }
});
