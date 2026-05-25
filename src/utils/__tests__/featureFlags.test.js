import test from 'node:test';
import assert from 'node:assert/strict';
import { getFeatureFlag } from '../featureFlags.js';

test('getFeatureFlag returns false for unknown flag', () => {
  assert.equal(getFeatureFlag('any-tenant', 'unknownFlag'), false);
});

test('getFeatureFlag returns env-overridden value', () => {
  process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION = 'true';
  assert.equal(getFeatureFlag('any-tenant', 'referralSalesAgentAttribution'), true);
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION;
});

test('getFeatureFlag respects tenant allowlist', () => {
  process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION_TENANTS = 'tenant-a,tenant-b';
  assert.equal(getFeatureFlag('tenant-a', 'referralSalesAgentAttribution'), true);
  assert.equal(getFeatureFlag('tenant-c', 'referralSalesAgentAttribution'), false);
  delete process.env.FF_REFERRAL_SALES_AGENT_ATTRIBUTION_TENANTS;
});
