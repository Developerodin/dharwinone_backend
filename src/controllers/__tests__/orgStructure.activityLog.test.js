import test, { mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityActions, EntityTypes } from '../../config/activityLog.js';

const mockCreateOrgUnit = mock.fn(async () => ({
  result: { id: 'u1', name: 'Sales' },
  audit: {
    action: ActivityActions.ORG_UNIT_CREATE,
    entityType: EntityTypes.ORG_UNIT,
    entityId: 'u1',
    metadata: { fieldsUpdated: ['name'], parentIdAfter: null, headEmployeeIdAfter: null },
    occurredAt: new Date('2026-06-09T00:00:00.000Z'),
  },
}));

const mockExportReport = mock.fn(async () => ({
  result: { generatedAt: '2026-06-09', hierarchy: [] },
  audit: {
    action: ActivityActions.ORG_STRUCTURE_EXPORT,
    entityType: EntityTypes.ORG_STRUCTURE,
    entityId: 'compliance-report',
    metadata: { format: 'json', rowCount: 2, employeeCount: 10, outcome: 'success' },
    occurredAt: new Date('2026-06-09T00:00:00.000Z'),
  },
}));

const mockPersist = mock.fn(async () => ({ id: 'log1' }));

mock.module('../../services/orgStructure.service.js', {
  namedExports: {
    createOrgUnit: mockCreateOrgUnit,
    exportComplianceReport: mockExportReport,
  },
});

mock.module('../../services/activityLog.service.js', {
  namedExports: {
    persistActivityLogFailSoft: mockPersist,
  },
});

let controller;

before(async () => {
  mockPersist.mock.resetCalls();
  mockCreateOrgUnit.mock.resetCalls();
  mockExportReport.mock.resetCalls();
  controller = await import('../orgStructure.controller.js');
});

const runHandler = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, body: payload });
      },
    };
    handler(req, res, (err) => (err ? reject(err) : resolve({ statusCode: res.statusCode, body: undefined })));
  });

test('createOrgUnit persists orgUnit.create audit envelope', async () => {
  mockPersist.mock.resetCalls();
  const req = { body: { name: 'Sales', type: 'department' }, user: { _id: 'actor1' } };
  const out = await runHandler(controller.createOrgUnit, req);
  assert.equal(out.statusCode, 201);
  assert.equal(mockPersist.mock.calls.length, 1);
  const [actorId, envelope] = mockPersist.mock.calls[0].arguments;
  assert.equal(actorId, 'actor1');
  assert.equal(envelope.audit.action, ActivityActions.ORG_UNIT_CREATE);
  assert.equal(envelope.audit.entityType, EntityTypes.ORG_UNIT);
  assert.equal(envelope.audit.entityId, 'u1');
});

test('exportReport persists orgStructure.export audit envelope', async () => {
  mockPersist.mock.resetCalls();
  const req = { user: { id: 'actor2' }, query: {} };
  const out = await runHandler(controller.exportReport, req);
  assert.equal(out.statusCode, 200);
  assert.equal(mockPersist.mock.calls.length, 1);
  const [actorId, envelope] = mockPersist.mock.calls[0].arguments;
  assert.equal(actorId, 'actor2');
  assert.equal(envelope.audit.action, ActivityActions.ORG_STRUCTURE_EXPORT);
  assert.equal(envelope.audit.entityType, EntityTypes.ORG_STRUCTURE);
  assert.deepEqual(envelope.audit.metadata.format, 'json');
});
