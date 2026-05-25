import test from 'node:test';
import assert from 'node:assert/strict';
import requireFeatureFlag from '../../middlewares/requireFeatureFlag.js';
import { FEATURE_FLAG_NAME } from '../../constants/salesAgentAttribution.js';

function mockReq(tenantId = 'tenant-a') {
  return { user: { tenantId } };
}

function mockRes() {
  let status = 200;
  let body;
  return {
    status(c) {
      status = c;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    _status: () => status,
    _body: () => body,
  };
}

test('POST /sales-agent route middleware returns 404 when flag is off', () => {
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION;
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION_TENANTS;

  const res = mockRes();
  let nextCalled = false;
  requireFeatureFlag(FEATURE_FLAG_NAME)(mockReq(), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res._status(), 404);
  assert.deepEqual(res._body(), { error: 'Not found' });
});

test('sales-agent middleware passes when global flag is on', () => {
  process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION = 'true';
  let nextCalled = false;
  requireFeatureFlag(FEATURE_FLAG_NAME)(mockReq(), mockRes(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION;
});

test('sales-agent middleware passes for tenant on allowlist', () => {
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION;
  process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION_TENANTS = 'tenant-a,tenant-b';
  let nextCalled = false;
  requireFeatureFlag(FEATURE_FLAG_NAME)(mockReq('tenant-a'), mockRes(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION_TENANTS;
});
