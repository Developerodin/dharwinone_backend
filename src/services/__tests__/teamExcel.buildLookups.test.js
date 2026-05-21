import { test } from 'node:test';
import assert from 'node:assert/strict';
import Employee from '../../models/employee.model.js';
import { buildEmployeeLookups, _matchOne } from '../teamExcel.service.js';

/**
 * BUG 2(a): buildEmployeeLookups previously indexed by the non-existent root
 * field `d.name`, so the by-name index was always empty and name-tier matching
 * never resolved anyone. Employee's display name field is `fullName`.
 *
 * Employee.find is mocked to return `fullName`-shaped docs (the real schema)
 * so the test exercises buildEmployeeLookups without a live DB.
 */
function mockEmployeeFind(t, docs) {
  t.mock.method(Employee, 'find', () => ({
    select() {
      return this;
    },
    lean() {
      return Promise.resolve(docs);
    },
  }));
}

test('BUG 2(a): buildEmployeeLookups indexes employees by fullName so name matching works', async (t) => {
  const ASHA = {
    _id: 'o1',
    employeeId: 'DBS101',
    fullName: 'Asha Sharma',
    email: 'asha@x.com',
    isActive: true,
  };
  mockEmployeeFind(t, [ASHA]);

  const lookups = await buildEmployeeLookups([{ employeeName: 'Asha Sharma' }]);

  // The by-name index must be populated (the bug left it empty).
  assert.ok(lookups.byName.has('asha sharma'), 'byName index missing the fullName key');
  assert.deepEqual(lookups.byName.get('asha sharma'), [ASHA]);

  // An imported row matching by name resolves the employee end-to-end.
  const result = _matchOne({ employeeName: 'Asha Sharma' }, lookups);
  assert.equal(result.matched, ASHA);
});

test('BUG 2(a): duplicate fullName values produce an ambiguous (length > 1) by-name bucket', async (t) => {
  const JOHN1 = { _id: 'o2', fullName: 'John Doe', email: 'jd1@x.com', isActive: true };
  const JOHN2 = { _id: 'o3', fullName: 'John Doe', email: 'jd2@x.com', isActive: true };
  mockEmployeeFind(t, [JOHN1, JOHN2]);

  const lookups = await buildEmployeeLookups([{ employeeName: 'John Doe' }]);
  assert.equal(lookups.byName.get('john doe').length, 2);

  const result = _matchOne({ employeeName: 'John Doe' }, lookups);
  assert.equal(result.matched, null);
  assert.equal(result.skipReason, 'ambiguous_employee_name');
  assert.equal(result.matchCount, 2);
});
