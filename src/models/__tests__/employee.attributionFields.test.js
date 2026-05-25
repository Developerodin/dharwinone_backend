import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Employee from '../employee.model.js';

test('Employee has attributionJobId and cache fields', () => {
  const paths = Employee.schema.paths;
  assert.equal(paths.attributionJobId.instance, 'ObjectId');
  assert.equal(paths.currentSalesAgentUserId.instance, 'ObjectId');
  assert.equal(paths.currentSalesAgentAssignedAt.instance, 'Date');
  assert.equal(paths.currentSalesAgentJobId.instance, 'ObjectId');
});

test('all new fields default to null', () => {
  const doc = new Employee({
    fullName: 'x',
    email: 'a@b',
    tenantId: new mongoose.Types.ObjectId(),
  });
  assert.equal(doc.attributionJobId, null);
  assert.equal(doc.currentSalesAgentUserId, null);
  assert.equal(doc.currentSalesAgentAssignedAt, null);
  assert.equal(doc.currentSalesAgentJobId, null);
});
