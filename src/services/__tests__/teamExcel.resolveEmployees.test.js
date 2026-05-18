import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmployeesFromRows, _matchOne } from '../teamExcel.service.js';

const ASHA = { _id: 'o1', employeeId: 'DBS101', name: 'Asha Sharma', email: 'asha@x.com', isActive: true };
const BOB1 = { _id: 'o2', employeeId: 'DBS201', name: 'John Doe', email: 'jd1@x.com', isActive: true };
const BOB2 = { _id: 'o3', employeeId: 'DBS202', name: 'John Doe', email: 'jd2@x.com', isActive: true };

const lookups = {
  byInternalId: new Map([['o1', ASHA]]),
  byEmployeeId: new Map([['DBS101', ASHA]]),
  byEmail: new Map([['asha@x.com', ASHA]]),
  byName: new Map([
    ['asha sharma', [ASHA]],
    ['john doe', [BOB1, BOB2]],
  ]),
};

test('priority 0: Employee Internal ID wins', () => {
  const r = _matchOne({ employeeInternalId: 'o1', employeeEmail: 'wrong@x.com' }, lookups);
  assert.equal(r.matched, ASHA);
});

test('priority 1: Employee ID when Internal ID empty', () => {
  const r = _matchOne({ employeeId: 'DBS101' }, lookups);
  assert.equal(r.matched, ASHA);
});

test('priority 2: Email when above empty', () => {
  const r = _matchOne({ employeeEmail: 'asha@x.com' }, lookups);
  assert.equal(r.matched, ASHA);
});

test('priority 3: Name only if exactly one match', () => {
  const r1 = _matchOne({ employeeName: 'Asha Sharma' }, lookups);
  assert.equal(r1.matched, ASHA);
  const r2 = _matchOne({ employeeName: 'John Doe' }, lookups);
  assert.equal(r2.matched, null);
  assert.equal(r2.skipReason, 'ambiguous_employee_name');
  assert.equal(r2.matchCount, 2);
});

test('no identifiers -> missing_identifiers', () => {
  const r = _matchOne({}, lookups);
  assert.equal(r.skipReason, 'missing_identifiers');
});

test('resolveEmployeesFromRows attaches matched/skipReason to each row', () => {
  const rows = [{ employeeId: 'DBS101' }, { employeeName: 'John Doe' }, {}];
  const out = resolveEmployeesFromRows(rows, lookups);
  assert.equal(out[0].matched, ASHA);
  assert.equal(out[1].skipReason, 'ambiguous_employee_name');
  assert.equal(out[2].skipReason, 'missing_identifiers');
});
