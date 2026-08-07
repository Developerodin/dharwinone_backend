import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { employeeOwnerQuery, getVisibleUserStatuses } from '../visibilityRules.js';

// Regression: the chatbot answered "35 resigned employees" where the Employees
// page answered 34. The extra row was an employee whose User account is
// `disabled`. Cause: the legacy fetch_employees path widened the OWNER ACCOUNT
// scope to `{ $ne: 'deleted' }` whenever employmentStatus was 'resigned' or
// 'all', instead of using visibleUserStatusClause().
//
// Employment scope (active/resigned/all) describes the EMPLOYMENT record
// (Employee.resignDate). It must never widen ACCOUNT visibility. This helper
// exists so that widening is not representable at the call site.

describe('employeeOwnerQuery', () => {
  const roleIds = ['role-employee-1'];

  it('scopes to the Employee role ids it was given', () => {
    assert.deepEqual(employeeOwnerQuery({ roleIds }).roleIds, { $in: roleIds });
  });

  it('excludes platform super users', () => {
    assert.deepEqual(employeeOwnerQuery({ roleIds }).platformSuperUser, { $ne: true });
  });

  it('defaults account visibility to active + pending', () => {
    assert.deepEqual(employeeOwnerQuery({ roleIds }).status, { $in: ['active', 'pending'] });
  });

  it('never includes disabled accounts by default', () => {
    const { status } = employeeOwnerQuery({ roleIds });
    assert.ok(!status.$in.includes('disabled'), 'disabled must not be visible by default');
    assert.ok(!status.$in.includes('archived'), 'archived must not be visible by default');
    assert.ok(!status.$in.includes('deleted'), 'deleted is never visible');
  });

  it('ignores employment scope entirely, so resigned/all cannot widen it', () => {
    // The bug was a per-scope branch on exactly these two values. Passing them
    // must be inert: same account scope for every employment scope.
    const base = employeeOwnerQuery({ roleIds });
    for (const scope of ['active', 'resigned', 'all']) {
      assert.deepEqual(
        employeeOwnerQuery({ roleIds, employmentStatus: scope, scope }),
        base,
        `employment scope "${scope}" must not change the account scope`
      );
    }
    assert.deepEqual(base.status, { $in: getVisibleUserStatuses() });
  });

  it('still honours an explicit includeDisabled override', () => {
    const { status } = employeeOwnerQuery({ roleIds, override: { includeDisabled: true } });
    assert.ok(status.$in.includes('disabled'), 'explicit override must still widen');
  });

  it('matches the clause peopleFetcher already built inline', () => {
    // Both paths must agree, or a count and a list can disagree for the same
    // question.
    assert.deepEqual(employeeOwnerQuery({ roleIds }), {
      roleIds: { $in: roleIds },
      status: { $in: ['active', 'pending'] },
      platformSuperUser: { $ne: true },
    });
  });
});
