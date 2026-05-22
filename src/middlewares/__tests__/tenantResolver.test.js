/**
 * P3 Regression Tests: tenantResolver middleware
 *
 * Verifies that req.tenantId is correctly resolved from:
 *   1. user.tenantId (P3 migrated)
 *   2. user.adminId (legacy non-admin users)
 *   3. user._id (admin/super-user with no adminId)
 * And that requireTenant() blocks requests with missing tenant context.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { tenantResolver, requireTenant } from '../tenantResolver.js';

const makeReq = (user) => ({ user });
const makeRes = () => {
  const res = {};
  res.status = (code) => { res._code = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
};

test('tenantResolver — no-ops when req.user is absent', (t, done) => {
  const req = {};
  tenantResolver(req, {}, () => {
    assert.equal(req.tenantId, undefined);
    done();
  });
});

test('tenantResolver — picks user.tenantId (P3 migrated) first', (t, done) => {
  const tenantId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const req = makeReq({ tenantId, adminId, _id: new mongoose.Types.ObjectId() });
  tenantResolver(req, {}, () => {
    assert.deepEqual(req.tenantId, tenantId);
    done();
  });
});

test('tenantResolver — falls back to user.adminId when tenantId absent', (t, done) => {
  const adminId = new mongoose.Types.ObjectId();
  const req = makeReq({ adminId, _id: new mongoose.Types.ObjectId() });
  tenantResolver(req, {}, () => {
    assert.deepEqual(req.tenantId, adminId);
    done();
  });
});

test('tenantResolver — uses user._id when neither tenantId nor adminId present (admin/root)', (t, done) => {
  const userId = new mongoose.Types.ObjectId();
  const req = makeReq({ _id: userId });
  tenantResolver(req, {}, () => {
    assert.deepEqual(req.tenantId, userId);
    done();
  });
});

test('requireTenant — passes through when tenantId is set', (t, done) => {
  const req = { tenantId: new mongoose.Types.ObjectId() };
  requireTenant(req, makeRes(), () => {
    done();
  });
});

test('requireTenant — responds 403 when tenantId is missing', (t, done) => {
  const req = {};
  const res = makeRes();
  requireTenant(req, res, () => {
    assert.fail('next() should not have been called');
  });
  setImmediate(() => {
    assert.equal(res._code, 403);
    assert.ok(res._body.message);
    done();
  });
});
