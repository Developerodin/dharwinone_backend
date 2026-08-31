import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import requirePermissions from '../../middlewares/requirePermissions.js';
import { errorConverter, errorHandler } from '../../middlewares/error.js';

/**
 * GET /notifications/admin/audit must be gated by an admin-tier permission
 * (activityLogs.manage), not candidates.manage — the audit endpoint can return
 * ANY user's notifications, including private chat_message previews, so a
 * recruiter-level "manage ATS candidates" grant must not unlock it.
 */

/** Inject req.user/req.authContext the way auth() middleware does after JWT validation. */
function injectAuth({ perms = [], platformSuperUser = false } = {}) {
  return (req, _res, next) => {
    req.user = { id: 'test-user', platformSuperUser };
    req.authContext = { permissions: new Set(perms) };
    next();
  };
}

function buildAuditApp({ perms, platformSuperUser, skipAuth = false } = {}) {
  const app = express();
  app.use(express.json());
  const middlewares = [requirePermissions('activityLogs.manage')];
  if (skipAuth) {
    app.get('/admin/audit', ...middlewares, (_req, res) => res.status(200).json({ ok: true }));
  } else {
    app.get('/admin/audit', injectAuth({ perms, platformSuperUser }), ...middlewares, (_req, res) =>
      res.status(200).json({ ok: true })
    );
  }
  app.use(errorConverter);
  app.use(errorHandler);
  return app;
}

test('GET /admin/audit with activityLogs.manage → 200', async () => {
  const app = buildAuditApp({ perms: ['activityLogs.manage'] });
  const res = await request(app).get('/admin/audit');
  assert.equal(res.status, 200);
});

test('GET /admin/audit with activity.manage (alias) → 200', async () => {
  const app = buildAuditApp({ perms: ['activity.manage'] });
  const res = await request(app).get('/admin/audit');
  assert.equal(res.status, 200);
});

test('GET /admin/audit as platformSuperUser (no explicit perms) → 200', async () => {
  const app = buildAuditApp({ perms: [], platformSuperUser: true });
  const res = await request(app).get('/admin/audit');
  assert.equal(res.status, 200);
});

test('GET /admin/audit with ONLY candidates.manage → 403 (no longer sufficient)', async () => {
  const app = buildAuditApp({ perms: ['candidates.manage'] });
  const res = await request(app).get('/admin/audit');
  assert.equal(res.status, 403);
});

test('GET /admin/audit with no permissions (authenticated, unprivileged) → 403', async () => {
  const app = buildAuditApp({ perms: [] });
  const res = await request(app).get('/admin/audit');
  assert.equal(res.status, 403);
});

test('GET /admin/audit unauthenticated (no req.user/authContext) → 401', async () => {
  const app = buildAuditApp({ skipAuth: true });
  const res = await request(app).get('/admin/audit');
  assert.equal(res.status, 401);
});

test('GET /admin/audit?userId=<other-user> with candidates.manage only → 403 (query param does not bypass authorization)', async () => {
  const app = buildAuditApp({ perms: ['candidates.manage'] });
  const res = await request(app).get('/admin/audit').query({ userId: 'someone-elses-id' });
  assert.equal(res.status, 403);
});

test('GET /admin/audit?userId=<other-user> with activityLogs.manage → 200 (authorized users may still filter by userId)', async () => {
  const app = buildAuditApp({ perms: ['activityLogs.manage'] });
  const res = await request(app).get('/admin/audit').query({ userId: 'someone-elses-id' });
  assert.equal(res.status, 200);
});
