import test from 'node:test';
import assert from 'node:assert/strict';
import Employee from '../../models/employee.model.js';
import { findUniqueEmployeeByEmail } from '../team.service.js';

test('findUniqueEmployeeByEmail returns null when email is empty', async (t) => {
  t.mock.method(Employee, 'find', () => ({
    select: () => ({
      exec: async () => [],
      then: (resolve) => resolve([]),
    }),
  }));
  assert.equal(await findUniqueEmployeeByEmail(''), null);
  assert.equal(await findUniqueEmployeeByEmail(null), null);
});

test('findUniqueEmployeeByEmail returns employee when exactly one match', async (t) => {
  const emp = { _id: '507f1f77bcf86cd799439011', designation: 'Dev', department: 'Eng' };
  t.mock.method(Employee, 'find', () => ({
    select: () => Promise.resolve([emp]),
  }));
  const result = await findUniqueEmployeeByEmail('saiful@example.com');
  assert.equal(result, emp);
});

test('findUniqueEmployeeByEmail returns null when multiple matches', async (t) => {
  t.mock.method(Employee, 'find', () => ({
    select: () => Promise.resolve([{ _id: 'a' }, { _id: 'b' }]),
  }));
  assert.equal(await findUniqueEmployeeByEmail('dup@example.com'), null);
});
