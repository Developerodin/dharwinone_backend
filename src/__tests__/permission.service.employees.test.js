import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveApiPermissions } from '../services/permission.service.js';

test('deriveApiPermissions: ats.employees full CRUD emits granular + manage', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:view,create,edit,delete']));
  assert.equal(derived.has('employees.read'), true);
  assert.equal(derived.has('employees.create'), true);
  assert.equal(derived.has('employees.edit'), true);
  assert.equal(derived.has('employees.delete'), true);
  assert.equal(derived.has('employees.manage'), true);
});

test('deriveApiPermissions: ats.employees:view emits read only', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:view']));
  assert.equal(derived.has('employees.read'), true);
  assert.equal(derived.has('employees.create'), false);
  assert.equal(derived.has('employees.manage'), false);
});

test('deriveApiPermissions: ats.employees:view,create emits create not edit/delete', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:view,create']));
  assert.equal(derived.has('employees.read'), true);
  assert.equal(derived.has('employees.create'), true);
  assert.equal(derived.has('employees.edit'), false);
  assert.equal(derived.has('employees.delete'), false);
  assert.equal(derived.has('employees.manage'), true);
});

test('deriveApiPermissions: ats.employees:create emits create + manage only', () => {
  const derived = deriveApiPermissions(new Set(['ats.employees:create']));
  assert.equal(derived.has('employees.read'), false);
  assert.equal(derived.has('employees.create'), true);
  assert.equal(derived.has('employees.edit'), false);
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
