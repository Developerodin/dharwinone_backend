import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';

test('config exposes ai block with defaults', () => {
  assert.ok(config.ai, 'config.ai should exist');
  assert.equal(config.ai.summaryModel, 'gpt-4o-mini');
  assert.equal(config.ai.extractionModel, 'gpt-4o');
  assert.equal(config.ai.finalizeTimeoutMs, 300000);
  assert.equal(config.ai.workerConcurrency, 4);
  assert.equal(config.ai.maxMeetingDurationMinutes, 240);
  assert.equal(config.ai.maxTranscriptTokens, 200000);
  assert.equal(config.ai.segmentWindowMs, 30000);
});

test('config exposes redis block with defaults', () => {
  assert.ok(config.redis, 'config.redis should exist');
  assert.ok(config.redis.url, 'config.redis.url should default to a localhost url');
  assert.equal(config.redis.queueDb, 1);
  assert.equal(config.redis.partialDb, 2);
});

test('config exposes retention block with defaults', () => {
  assert.ok(config.retention);
  assert.equal(config.retention.transcriptDays, 365);
  assert.equal(config.retention.summaryDays, 365);
  assert.equal(config.retention.agentDispatchDays, 30);
  assert.equal(config.retention.processedWebhookDays, 7);
  assert.equal(config.retention.dlqDays, 90);
});
