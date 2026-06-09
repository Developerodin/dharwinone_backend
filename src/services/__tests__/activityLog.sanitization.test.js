import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDeniedAuditMetadata } from '../activityLog.service.js';

test('sanitizeDeniedAuditMetadata keeps allowlisted keys only', () => {
  const out = sanitizeDeniedAuditMetadata({
    permission: 'structure.manage',
    reason: 'forbidden',
    targetEntityType: 'OrgUnit',
    targetEntityId: 'abc',
    route: '/v1/org-structure/x',
    requestId: 'req-1',
    email: 'secret@example.com',
    body: { parentId: 'evil' },
    password: 'nope',
  });
  assert.deepEqual(out, {
    permission: 'structure.manage',
    reason: 'forbidden',
    targetEntityType: 'OrgUnit',
    targetEntityId: 'abc',
    route: '/v1/org-structure/x',
    requestId: 'req-1',
  });
});
