import test, { mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityActions, EntityTypes } from '../../config/activityLog.js';

const mockCreateDepartment = mock.fn(async () => ({
  result: { id: 'd1', name: 'Engineering' },
  audit: {
    action: ActivityActions.DEPARTMENT_CREATE,
    entityType: EntityTypes.DEPARTMENT,
    entityId: 'd1',
    metadata: { fieldsUpdated: ['name'] },
    occurredAt: new Date('2026-06-09T00:00:00.000Z'),
  },
}));

const mockPersist = mock.fn(async () => ({ id: 'log1' }));

mock.module('../../services/department.service.js', {
  namedExports: {
    createDepartment: mockCreateDepartment,
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
  controller = await import('../department.controller.js');
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

test('createDepartment persists department.create audit envelope', async () => {
  mockPersist.mock.resetCalls();
  const req = { body: { name: 'Engineering' }, user: { _id: 'hr1' } };
  const out = await runHandler(controller.createDepartment, req);
  assert.equal(out.statusCode, 201);
  assert.equal(mockPersist.mock.calls.length, 1);
  const [actorId, envelope] = mockPersist.mock.calls[0].arguments;
  assert.equal(actorId, 'hr1');
  assert.equal(envelope.audit.action, ActivityActions.DEPARTMENT_CREATE);
  assert.equal(envelope.audit.entityType, EntityTypes.DEPARTMENT);
  assert.equal(envelope.audit.entityId, 'd1');
});
