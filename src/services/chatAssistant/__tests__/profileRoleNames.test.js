import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileRoleNamesFor, ROLE_GROUPS } from '../../chatAssistant.service.js';

// Regression: fetch_employees treated `canonicalRole === 'Candidate'` as part
// of the "employee population", but then built the owner scope from the
// Employee role ids only. Asking for candidates silently answered with
// employees — including the 35 resigned ones — while the reply was still
// labelled "Candidates".
//
// ROLE_GROUPS states the rule: "Candidate and Employee are DISTINCT roles in
// Dharwin — never merged."

describe('profileRoleNamesFor', () => {
  it('maps a Candidate request to the Candidate role only', () => {
    assert.deepEqual(profileRoleNamesFor('Candidate'), ROLE_GROUPS.candidate);
  });

  it('never leaks Employee into a Candidate request', () => {
    assert.ok(
      !profileRoleNamesFor('Candidate').includes('Employee'),
      'a Candidate query must not resolve the Employee role'
    );
  });

  it('maps an Employee request to the Employee role only', () => {
    assert.deepEqual(profileRoleNamesFor('Employee'), ROLE_GROUPS.employee);
  });

  it('never leaks Candidate into an Employee request', () => {
    assert.ok(
      !profileRoleNamesFor('Employee').includes('Candidate'),
      'an Employee query must not resolve the Candidate role'
    );
  });

  it('defaults to Employee when no role was requested (plain headcount)', () => {
    assert.deepEqual(profileRoleNamesFor(null), ROLE_GROUPS.employee);
    assert.deepEqual(profileRoleNamesFor(undefined), ROLE_GROUPS.employee);
  });

  it('returns disjoint sets for the two populations', () => {
    const emp = new Set(profileRoleNamesFor('Employee'));
    const overlap = profileRoleNamesFor('Candidate').filter((n) => emp.has(n));
    assert.deepEqual(overlap, [], 'populations must not intersect');
  });
});
