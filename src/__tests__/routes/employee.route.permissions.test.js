import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import { errorConverter, errorHandler } from '../../middlewares/error.js';

/** Inject authContext the way auth() middleware does after JWT validation. */
function injectAuth(perms) {
  return (req, _res, next) => {
    req.user = { id: 'test-user' };
    req.authContext = { permissions: new Set(perms) };
    next();
  };
}

function buildApp({ perms, method, path, middlewares }) {
  const app = express();
  app.use(express.json());
  app[method](path, injectAuth(perms), ...middlewares, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorConverter);
  app.use(errorHandler);
  return app;
}

const canReadEmployees = [requireAnyOfPermissions('candidates.read', 'employees.read')];
const canCreateEmployees = [requireAnyOfPermissions('candidates.manage', 'employees.create')];
const canEditEmployees = [requireAnyOfPermissions('candidates.manage', 'employees.edit')];
const canDeleteEmployees = [requireAnyOfPermissions('candidates.manage', 'employees.delete')];
const canManageCandidatesOnly = [requirePermissions('candidates.manage')];
const canUpdateJoiningDate = [
  requireAnyOfPermissions('candidates.manage', 'onboarding.manage', 'employees.edit'),
];
const canUpdateResignDate = [requireAnyOfPermissions('candidates.manage', 'employees.edit')];

test('GET /employees with employees.read only → 200', async () => {
  const app = buildApp({
    perms: ['employees.read'],
    method: 'get',
    path: '/employees',
    middlewares: canReadEmployees,
  });
  const res = await request(app).get('/employees');
  assert.equal(res.status, 200);
});

test('GET /employees with candidates.read legacy → 200', async () => {
  const app = buildApp({
    perms: ['candidates.read'],
    method: 'get',
    path: '/employees',
    middlewares: canReadEmployees,
  });
  const res = await request(app).get('/employees');
  assert.equal(res.status, 200);
});

test('GET /employees with no employee/candidate read → 403', async () => {
  const app = buildApp({
    perms: ['jobs.read'],
    method: 'get',
    path: '/employees',
    middlewares: canReadEmployees,
  });
  const res = await request(app).get('/employees');
  assert.equal(res.status, 403);
});

test('PATCH /:id with employees.create only → 403 (create ≠ edit)', async () => {
  const app = buildApp({
    perms: ['employees.read', 'employees.create', 'employees.manage'],
    method: 'patch',
    path: '/:candidateId',
    middlewares: canEditEmployees,
  });
  const res = await request(app).patch('/abc').send({ fullName: 'Test' });
  assert.equal(res.status, 403);
});

test('PATCH /:id with employees.edit → 200', async () => {
  const app = buildApp({
    perms: ['employees.read', 'employees.edit'],
    method: 'patch',
    path: '/:candidateId',
    middlewares: canEditEmployees,
  });
  const res = await request(app).patch('/abc').send({ fullName: 'Test' });
  assert.equal(res.status, 200);
});

test('POST / with employees.create → 200', async () => {
  const app = buildApp({
    perms: ['employees.create'],
    method: 'post',
    path: '/',
    middlewares: canCreateEmployees,
  });
  const res = await request(app).post('/').send({ fullName: 'New' });
  assert.equal(res.status, 200);
});

test('PATCH /:id/joining-date with employees.edit → 200', async () => {
  const app = buildApp({
    perms: ['employees.edit'],
    method: 'patch',
    path: '/:candidateId/joining-date',
    middlewares: canUpdateJoiningDate,
  });
  const res = await request(app).patch('/abc/joining-date').send({ joiningDate: '2026-01-01' });
  assert.equal(res.status, 200);
});

test('PATCH /:id/joining-date with employees.create only → 403', async () => {
  const app = buildApp({
    perms: ['employees.create', 'employees.manage'],
    method: 'patch',
    path: '/:candidateId/joining-date',
    middlewares: canUpdateJoiningDate,
  });
  const res = await request(app).patch('/abc/joining-date').send({ joiningDate: '2026-01-01' });
  assert.equal(res.status, 403);
});

test('PATCH /:id/joining-date with onboarding.manage → 200', async () => {
  const app = buildApp({
    perms: ['onboarding.manage'],
    method: 'patch',
    path: '/:candidateId/joining-date',
    middlewares: canUpdateJoiningDate,
  });
  const res = await request(app).patch('/abc/joining-date').send({ joiningDate: '2026-01-01' });
  assert.equal(res.status, 200);
});

test('PATCH /:id/resign-date with employees.edit → 200', async () => {
  const app = buildApp({
    perms: ['employees.edit'],
    method: 'patch',
    path: '/:candidateId/resign-date',
    middlewares: canUpdateResignDate,
  });
  const res = await request(app).patch('/abc/resign-date').send({ resignDate: '2026-06-01' });
  assert.equal(res.status, 200);
});

test('PATCH /:id/resign-date with onboarding.manage only → 403', async () => {
  const app = buildApp({
    perms: ['onboarding.manage'],
    method: 'patch',
    path: '/:candidateId/resign-date',
    middlewares: canUpdateResignDate,
  });
  const res = await request(app).patch('/abc/resign-date').send({ resignDate: '2026-06-01' });
  assert.equal(res.status, 403);
});

test('POST /referral-leads/:id/override with employees.manage only → 403 (no leak)', async () => {
  const app = buildApp({
    perms: ['employees.manage'],
    method: 'post',
    path: '/referral-leads/:candidateId/override',
    middlewares: canManageCandidatesOnly,
  });
  const res = await request(app).post('/referral-leads/abc/override').send({ reason: 'test' });
  assert.equal(res.status, 403);
});

test('POST /referral-leads/:id/override with candidates.manage → 200', async () => {
  const app = buildApp({
    perms: ['candidates.manage'],
    method: 'post',
    path: '/referral-leads/:candidateId/override',
    middlewares: canManageCandidatesOnly,
  });
  const res = await request(app).post('/referral-leads/abc/override').send({ reason: 'test' });
  assert.equal(res.status, 200);
});

test('DELETE /:id with employees.delete → 200', async () => {
  const app = buildApp({
    perms: ['employees.delete'],
    method: 'delete',
    path: '/:candidateId',
    middlewares: canDeleteEmployees,
  });
  const res = await request(app).delete('/abc');
  assert.equal(res.status, 200);
});

test('DELETE /:id with employees.create only → 403', async () => {
  const app = buildApp({
    perms: ['employees.read', 'employees.create', 'employees.manage'],
    method: 'delete',
    path: '/:candidateId',
    middlewares: canDeleteEmployees,
  });
  const res = await request(app).delete('/abc');
  assert.equal(res.status, 403);
});

test('DELETE /:id with employees.read only → 403', async () => {
  const app = buildApp({
    perms: ['employees.read'],
    method: 'delete',
    path: '/:candidateId',
    middlewares: canDeleteEmployees,
  });
  const res = await request(app).delete('/abc');
  assert.equal(res.status, 403);
});
