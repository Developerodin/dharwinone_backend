import test, { mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityActions, EntityTypes } from '../../config/activityLog.js';

const mockActivityLogCreate = mock.fn(async () => {
  throw new Error('db unavailable');
});

const mockOutboxCreate = mock.fn(async (entry) => ({ ...entry, _id: 'outbox1' }));

mock.module('../../models/activityLog.model.js', {
  defaultExport: {
    create: mockActivityLogCreate,
  },
});

mock.module('../../models/activityLogOutbox.model.js', {
  defaultExport: {
    create: mockOutboxCreate,
  },
});

mock.module('../../config/logger.js', {
  defaultExport: {
    error: mock.fn(),
  },
});

let persistActivityLogFailSoft;

before(async () => {
  mockActivityLogCreate.mock.resetCalls();
  mockOutboxCreate.mock.resetCalls();
  const mod = await import('../activityLog.service.js');
  persistActivityLogFailSoft = mod.persistActivityLogFailSoft;
});

test('persistActivityLogFailSoft writes to outbox when ActivityLog.create fails', async () => {
  mockActivityLogCreate.mock.resetCalls();
  mockOutboxCreate.mock.resetCalls();

  const envelope = {
    audit: {
      action: ActivityActions.ORG_UNIT_UPDATE,
      entityType: EntityTypes.ORG_UNIT,
      entityId: 'u1',
      metadata: { fieldsUpdated: ['name'] },
      occurredAt: new Date('2026-06-09T00:00:00.000Z'),
    },
  };

  const req = {
    method: 'PATCH',
    baseUrl: '/v1/org-structure',
    route: { path: '/:orgUnitId' },
    headers: { 'x-request-id': 'req-99' },
  };

  const result = await persistActivityLogFailSoft('actor1', envelope, req);
  assert.equal(result, null);
  assert.equal(mockActivityLogCreate.mock.calls.length, 1);
  assert.equal(mockOutboxCreate.mock.calls.length, 1);
  const outboxEntry = mockOutboxCreate.mock.calls[0].arguments[0];
  assert.equal(outboxEntry.action, ActivityActions.ORG_UNIT_UPDATE);
  assert.equal(outboxEntry.entityType, EntityTypes.ORG_UNIT);
  assert.equal(outboxEntry.entityId, 'u1');
  assert.equal(outboxEntry.requestId, 'req-99');
});

test('persistActivityLogFailSoft skips when audit envelope is null', async () => {
  mockActivityLogCreate.mock.resetCalls();
  mockOutboxCreate.mock.resetCalls();
  const result = await persistActivityLogFailSoft('actor1', { audit: null }, null);
  assert.equal(result, null);
  assert.equal(mockActivityLogCreate.mock.calls.length, 0);
  assert.equal(mockOutboxCreate.mock.calls.length, 0);
});
