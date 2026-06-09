import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityActions, EntityTypes } from '../../config/activityLog.js';
import { buildEmployeeUpdateAuditEnvelope } from '../../utils/auditMetadata.helper.js';

const actions = {
  EMPLOYEE_DEPARTMENT_ASSIGN: ActivityActions.EMPLOYEE_DEPARTMENT_ASSIGN,
  CANDIDATE_UPDATE: ActivityActions.CANDIDATE_UPDATE,
  EMPLOYEE: EntityTypes.EMPLOYEE,
  CANDIDATE: EntityTypes.CANDIDATE,
};

test('buildEmployeeUpdateAuditEnvelope emits employee.departmentAssign on department change', () => {
  const envelope = buildEmployeeUpdateAuditEnvelope(
    { departmentId: 'dept-old' },
    { departmentId: 'dept-new' },
    { departmentId: 'dept-new' },
    'emp1',
    actions
  );
  assert.equal(envelope.audit.action, ActivityActions.EMPLOYEE_DEPARTMENT_ASSIGN);
  assert.equal(envelope.audit.entityType, EntityTypes.EMPLOYEE);
  assert.equal(envelope.audit.entityId, 'emp1');
  assert.equal(envelope.audit.metadata.departmentIdBefore, 'dept-old');
  assert.equal(envelope.audit.metadata.departmentIdAfter, 'dept-new');
});

test('buildEmployeeUpdateAuditEnvelope skips departmentAssign when department unchanged', () => {
  const envelope = buildEmployeeUpdateAuditEnvelope(
    { departmentId: 'dept-old' },
    { departmentId: 'dept-old' },
    { fullName: 'Updated Name' },
    'emp1',
    actions
  );
  assert.equal(envelope.audit.action, ActivityActions.CANDIDATE_UPDATE);
  assert.equal(envelope.audit.entityType, EntityTypes.CANDIDATE);
  assert.deepEqual(envelope.audit.metadata.fieldsUpdated, ['fullName']);
});

test('buildEmployeeUpdateAuditEnvelope returns null audit for empty body update', () => {
  const envelope = buildEmployeeUpdateAuditEnvelope(
    { departmentId: 'dept-old' },
    { departmentId: 'dept-old' },
    {},
    'emp1',
    actions
  );
  assert.equal(envelope.audit, null);
});
