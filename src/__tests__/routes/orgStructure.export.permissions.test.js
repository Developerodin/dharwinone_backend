import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import requirePermissions from '../../middlewares/requirePermissions.js';
import { errorConverter, errorHandler } from '../../middlewares/error.js';

/** Same gate as GET /export in orgStructure.route.js */
const canExportStructure = [
  requirePermissions('structure.export', {
    auditOnDeny: 'org.mutate.denied',
    targetEntityType: 'OrgStructure',
  }),
];

function injectAuth(perms) {
  return (req, _res, next) => {
    req.user = { id: 'test-user' };
    req.authContext = { permissions: new Set(perms) };
    next();
  };
}

function buildApp(perms) {
  const app = express();
  app.get('/export', injectAuth(perms), ...canExportStructure, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorConverter);
  app.use(errorHandler);
  return app;
}

test('GET /export with structure.export → 200', async () => {
  const res = await request(buildApp(['structure.export'])).get('/export');
  assert.equal(res.status, 200);
});

test('GET /export with structure.manage → 200', async () => {
  const res = await request(buildApp(['structure.manage'])).get('/export');
  assert.equal(res.status, 200);
});

test('GET /export with structure.read only → 403', async () => {
  const res = await request(buildApp(['structure.read'])).get('/export');
  assert.equal(res.status, 403);
});

test('GET /export without org read permissions → 403', async () => {
  const res = await request(buildApp(['jobs.read'])).get('/export');
  assert.equal(res.status, 403);
});
