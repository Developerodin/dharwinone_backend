import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActivityLogListFilter } from '../activityLog.controller.js';

const uid = 'u1';
const base = { isDesignated: false, isPlatformSuperUser: false, uid };

test('view-only sees own logs, filters ignored', () => {
  const f = resolveActivityLogListFilter({
    ...base,
    permissions: new Set(['activity.read']),
    query: { action: 'user.login', q: 'x', actor: 'other' },
  });
  assert.deepEqual(f, { actor: uid });
});

test('create+edit enables filters but actor stays self', () => {
  const f = resolveActivityLogListFilter({
    ...base,
    permissions: new Set(['activity.read', 'activity.create', 'activity.edit']),
    query: { action: 'user.login', q: 'x', actor: 'other' },
  });
  assert.equal(f.actor, uid);
  assert.equal(f.action, 'user.login');
  assert.equal(f.q, 'x');
});

test('create without edit does not enable filters', () => {
  const f = resolveActivityLogListFilter({
    ...base,
    permissions: new Set(['activity.read', 'activity.create']),
    query: { action: 'user.login' },
  });
  assert.deepEqual(f, { actor: uid });
});

test('delete sees all actors with filters', () => {
  const f = resolveActivityLogListFilter({
    ...base,
    permissions: new Set(['activity.read', 'activity.delete']),
    query: { actor: 'other', action: 'role.create' },
  });
  assert.equal(f.actor, 'other');
  assert.equal(f.action, 'role.create');
});

test('platformSuperUser sees all actors', () => {
  const f = resolveActivityLogListFilter({
    ...base,
    isPlatformSuperUser: true,
    permissions: new Set(),
    query: { actor: 'other' },
  });
  assert.equal(f.actor, 'other');
});
