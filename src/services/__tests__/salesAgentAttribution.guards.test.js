import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSameTenant,
  assertSalesAgentRole,
  assertActorMayAssign,
} from '../salesAgentAttribution.service.js';

test('assertSameTenant throws when tenants differ', () => {
  assert.throws(
    () => assertSameTenant({ tenantId: 'a' }, { tenantId: 'b' }),
    (err) => err.code === 'CROSS_TENANT_ASSIGNMENT_FORBIDDEN'
  );
});

test('assertSameTenant passes when tenants match', () => {
  assert.doesNotThrow(() => assertSameTenant({ tenantId: 'a' }, { tenantId: 'a' }));
});

test('assertSameTenant passes when legacy employee adminId matches user tenantId', () => {
  assert.doesNotThrow(() => assertSameTenant({ adminId: 'a' }, { tenantId: 'a' }));
});

test('assertSameTenant passes when stale user tenantId differs but adminId matches employee', () => {
  assert.doesNotThrow(() =>
    assertSameTenant({ adminId: 'org-admin' }, { tenantId: 'wrong-tenant', adminId: 'org-admin' })
  );
});

test('assertSameTenant passes when tenant root admin has only _id', () => {
  assert.doesNotThrow(() => assertSameTenant({ adminId: 'org-admin' }, { _id: 'org-admin' }));
});

test('assertSalesAgentRole rejects non-sales-agent', () => {
  assert.throws(() => assertSalesAgentRole({ roles: ['Administrator'] }), (err) =>
    err.code === 'SALES_AGENT_ROLE_REQUIRED'
  );
});

test('assertSalesAgentRole passes when role present (string array)', () => {
  assert.doesNotThrow(() => assertSalesAgentRole({ roles: ['sales_agent'] }));
});

test('assertSalesAgentRole passes when role present (populated objects)', () => {
  assert.doesNotThrow(() => assertSalesAgentRole({ roles: [{ name: 'sales_agent' }] }));
});

test('assertActorMayAssign blocks sales_agent actor', () => {
  assert.throws(() => assertActorMayAssign({ roles: ['sales_agent'] }), (err) =>
    err.code === 'SALES_AGENT_CANNOT_ASSIGN'
  );
});

test('assertActorMayAssign allows admin actor', () => {
  assert.doesNotThrow(() => assertActorMayAssign({ roles: ['Administrator'] }));
});
