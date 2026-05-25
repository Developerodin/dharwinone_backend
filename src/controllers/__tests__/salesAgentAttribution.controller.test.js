import test, { mock, before } from 'node:test';
import assert from 'node:assert/strict';

const mockAssign = mock.fn(async () => ({ attribution: { _id: 'a1' } }));
const mockLead = mock.fn(async () => ({ id: 'c1', salesAgent: null }));

mock.module('../../services/salesAgentAttribution.service.js', {
  namedExports: {
    assignSalesAgent: mockAssign,
    changeSalesAgent: mock.fn(),
    revokeSalesAgent: mock.fn(),
    getSalesAgentHistory: mock.fn(),
    pinAttributionJob: mock.fn(),
  },
});

mock.module('../../services/referralLeads.service.js', {
  namedExports: {
    getReferralLeadById: mockLead,
    listReferralLeads: mock.fn(),
    getReferralLeadsStats: mock.fn(),
    exportReferralLeadsCsv: mock.fn(),
    overrideReferralAttribution: mock.fn(),
    getReferralAttributionOverrideHistory: mock.fn(),
    syncReferralPipelineStatusForCandidate: mock.fn(async () => {}),
  },
});

let controller;
before(async () => {
  controller = await import('../employee.controller.js');
});

test('postSalesAgentAssignHandler returns 201 with attribution and lead', async () => {
  const req = {
    params: { candidateId: 'c1' },
    body: { salesAgentUserId: 'u1' },
    user: { _id: 'admin1', tenantId: 't1' },
  };
  const res = {
    statusCode: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {},
  };
  let body;
  await new Promise((resolve, reject) => {
    res.json = (payload) => {
      body = payload;
      resolve();
    };
    controller.postSalesAgentAssignHandler(req, res, (err) => {
      if (err) reject(err);
    });
  });
  assert.equal(res.statusCode, 201);
  assert.equal(body.attribution._id, 'a1');
  assert.equal(body.lead.id, 'c1');
});
