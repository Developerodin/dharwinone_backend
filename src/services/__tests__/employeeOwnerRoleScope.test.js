import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwnerUserRoleScope } from '../employee.service.js';

describe('normalizeOwnerUserRoleScope', () => {
  it('keeps candidate distinct from employee and jobSeeker', () => {
    assert.equal(normalizeOwnerUserRoleScope('candidate'), 'candidate');
    assert.equal(normalizeOwnerUserRoleScope('jobSeeker'), 'jobSeeker');
    assert.equal(normalizeOwnerUserRoleScope('employee'), 'employee');
  });

  it('falls back to employee for anything else, as before', () => {
    assert.equal(normalizeOwnerUserRoleScope(undefined), 'employee');
    assert.equal(normalizeOwnerUserRoleScope('Candidate'), 'employee');
    assert.equal(normalizeOwnerUserRoleScope(''), 'employee');
  });
});
