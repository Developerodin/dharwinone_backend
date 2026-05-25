import test from 'node:test';
import assert from 'node:assert/strict';
import requireFeatureFlag from '../requireFeatureFlag.js';

function mockReq(tenantId) {
  return { user: { tenantId } };
}
function mockRes() {
  let status = 200;
  return {
    status(c) {
      status = c;
      return this;
    },
    json() {
      return { _status: status };
    },
    _status: () => status,
  };
}

test('passes when flag is on', () => {
  process.env.FF_TEST_FLAG = 'true';
  const next = (err) => {
    assert.equal(err, undefined);
  };
  requireFeatureFlag('testFlag')(mockReq('t1'), mockRes(), next);
  delete process.env.FF_TEST_FLAG;
});

test('returns 404 when flag is off', () => {
  const res = mockRes();
  requireFeatureFlag('testFlag')(mockReq('t1'), res, () => assert.fail('next called'));
  assert.equal(res._status(), 404);
});
