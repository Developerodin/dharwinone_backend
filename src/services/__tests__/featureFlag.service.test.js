import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/config.js';
import { resolveFeatureFlag, __resetFeatureFlagCache } from '../featureFlag.service.js';

const baseUser = { id: '507f1f77bcf86cd799439011', email: 'member@example.com' };

beforeEach(() => {
  __resetFeatureFlagCache();
});

test('unknown flag returns disabled off rollout', () => {
  const result = resolveFeatureFlag('unknown-flag', baseUser);
  assert.equal(result.enabled, false);
  assert.equal(result.rollout, 'off');
});

test('taskboard-v2 defaults to off for regular users', () => {
  const prev = config.featureFlags.taskboardV2.rollout;
  config.featureFlags.taskboardV2.rollout = 'off';
  try {
    const result = resolveFeatureFlag('taskboard-v2', baseUser);
    assert.equal(result.enabled, false);
    assert.equal(result.rollout, 'off');
  } finally {
    config.featureFlags.taskboardV2.rollout = prev;
  }
});

test('taskboard-v2 all rollout enables everyone', () => {
  const prev = config.featureFlags.taskboardV2.rollout;
  config.featureFlags.taskboardV2.rollout = 'all';
  try {
    const result = resolveFeatureFlag('taskboard-v2', baseUser);
    assert.equal(result.enabled, true);
    assert.equal(result.rollout, 'all');
  } finally {
    config.featureFlags.taskboardV2.rollout = prev;
  }
});

test('taskboard-v2 allowlist enables user with userOverride when rollout is off', () => {
  const prevRollout = config.featureFlags.taskboardV2.rollout;
  const prevAllowlist = config.featureFlags.taskboardV2.allowlistEmails;
  config.featureFlags.taskboardV2.rollout = 'off';
  config.featureFlags.taskboardV2.allowlistEmails = new Set(['member@example.com']);
  try {
    const result = resolveFeatureFlag('taskboard-v2', baseUser);
    assert.equal(result.enabled, true);
    assert.equal(result.userOverride, true);
  } finally {
    config.featureFlags.taskboardV2.rollout = prevRollout;
    config.featureFlags.taskboardV2.allowlistEmails = prevAllowlist;
  }
});

test('taskboard-v2 internal rollout enables designated superadmin only', () => {
  const prevRollout = config.featureFlags.taskboardV2.rollout;
  config.featureFlags.taskboardV2.rollout = 'internal';
  try {
    const internalEmail = config.designatedSuperadminEmails[0];
    assert.ok(internalEmail, 'expected designated superadmin email in config');
    const enabled = resolveFeatureFlag('taskboard-v2', { id: '1', email: internalEmail });
    const blocked = resolveFeatureFlag('taskboard-v2', baseUser);
    assert.equal(enabled.enabled, true);
    assert.equal(blocked.enabled, false);
  } finally {
    config.featureFlags.taskboardV2.rollout = prevRollout;
  }
});

test('resolveFeatureFlag caches per user for 60s', () => {
  const prevRollout = config.featureFlags.taskboardV2.rollout;
  config.featureFlags.taskboardV2.rollout = 'all';
  try {
    const first = resolveFeatureFlag('taskboard-v2', baseUser);
    config.featureFlags.taskboardV2.rollout = 'off';
    const second = resolveFeatureFlag('taskboard-v2', baseUser);
    assert.deepEqual(first, second);
    assert.equal(second.enabled, true);
  } finally {
    config.featureFlags.taskboardV2.rollout = prevRollout;
  }
});
