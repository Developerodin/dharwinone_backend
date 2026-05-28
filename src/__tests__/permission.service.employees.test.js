import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveApiPermissions } from '../services/permission.service.js';

test('deriveApiPermissions: ats.employees full CRUD emits read + manage', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:view,create,edit,delete']));
  assert.equal(derived.has('employees.read'), true);
  assert.equal(derived.has('employees.manage'), true);
});

test('deriveApiPermissions: ats.employees:view emits read only', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:view']));
  assert.equal(derived.has('employees.read'), true);
  assert.equal(derived.has('employees.manage'), false);
});

test('deriveApiPermissions: ats.employees:create emits manage only', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:create']));
  assert.equal(derived.has('employees.read'), false);
  assert.equal(derived.has('employees.manage'), true);
});

test('deriveApiPermissions: ats.candidates:view does NOT cross-grant employees.read', () => {
  const derived = deriveApiPermissions(new Set(['ats.candidates:view']));
  assert.equal(derived.has('candidates.read'), true);
  assert.equal(derived.has('employees.read'), false);
});

test('deriveApiPermissions: ats.candidates full CRUD does NOT cross-grant employees.manage', () => {
  const derived = deriveApiPermissions(new Set(['ats.candidates:view,create,edit,delete']));
  assert.equal(derived.has('candidates.manage'), true);
  assert.equal(derived.has('employees.manage'), false);
});
