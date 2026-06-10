import test from 'node:test';
import assert from 'node:assert/strict';

// Permission-based visibility (tenant-independent):
//   interviews.manage -> ALL interviews | interviews.read -> OWN | neither -> none
//   meetings.manage   -> ALL meetings   | meetings.read   -> OWN | neither -> none
// Interview and meeting permission families must stay isolated (no cross-leak).

const ACTOR = { _id: '507f1f77bcf86cd799439013', email: 'user@example.com' };

const mockPerms = (t, granted) => {
  t.mock.module('../../utils/permissionCheck.js', {
    namedExports: {
      hasApiPermission: async (_user, required) => granted.has(required),
      hasApiPermissionFromContext: () => false,
      hasPermission: async () => false,
      hasPermissionFromContext: () => false,
    },
  });
};

const EMPTY = { _id: { $in: [] } };

test('meetingScope: interviews.manage (full CRUD) sees ALL interviews', async (t) => {
  mockPerms(t, new Set(['interviews.manage', 'interviews.read']));
  const { meetingScope } = await import('../visibilityScope.service.js?t=int-manage');
  const { filter, scopeDebug } = await meetingScope(ACTOR, 'read');
  assert.deepEqual(filter, {});
  assert.equal(scopeDebug.role, 'interviews.manage:all');
});

test('meetingScope: interviews.read only (view) sees OWN interviews', async (t) => {
  mockPerms(t, new Set(['interviews.read']));
  const { meetingScope } = await import('../visibilityScope.service.js?t=int-read');
  const { filter, scopeDebug } = await meetingScope(ACTOR, 'read');
  assert.equal(scopeDebug.role, 'interviews.read:own');
  assert.ok(filter.$or.some((c) => c.createdBy));
});

test('meetingScope: no interview permission sees nothing', async (t) => {
  mockPerms(t, new Set());
  const { meetingScope } = await import('../visibilityScope.service.js?t=int-none');
  const { filter, scopeDebug } = await meetingScope(ACTOR, 'read');
  assert.equal(scopeDebug.role, 'none');
  assert.deepEqual(filter, EMPTY);
});

test('internalMeetingScope: meetings.manage sees ALL meetings', async (t) => {
  mockPerms(t, new Set(['meetings.manage', 'meetings.read']));
  const { internalMeetingScope } = await import('../visibilityScope.service.js?t=mtg-manage');
  const { filter, scopeDebug } = await internalMeetingScope(ACTOR, 'read');
  assert.deepEqual(filter, {});
  assert.equal(scopeDebug.role, 'meetings.manage:all');
});

test('internalMeetingScope: meetings.read only sees OWN meetings', async (t) => {
  mockPerms(t, new Set(['meetings.read']));
  const { internalMeetingScope } = await import('../visibilityScope.service.js?t=mtg-read');
  const { filter, scopeDebug } = await internalMeetingScope(ACTOR, 'read');
  assert.equal(scopeDebug.role, 'meetings.read:own');
  assert.ok(filter.$or.some((c) => c.createdBy));
});

test('no cross-leak: interviews.manage grants NO internal-meeting visibility', async (t) => {
  mockPerms(t, new Set(['interviews.manage']));
  const { internalMeetingScope } = await import('../visibilityScope.service.js?t=mtg-noleak');
  const { filter, scopeDebug } = await internalMeetingScope(ACTOR, 'read');
  assert.equal(scopeDebug.role, 'none');
  assert.deepEqual(filter, EMPTY);
});

test('no cross-leak: meetings.manage grants NO interview visibility', async (t) => {
  mockPerms(t, new Set(['meetings.manage']));
  const { meetingScope } = await import('../visibilityScope.service.js?t=int-noleak');
  const { filter, scopeDebug } = await meetingScope(ACTOR, 'read');
  assert.equal(scopeDebug.role, 'none');
  assert.deepEqual(filter, EMPTY);
});
