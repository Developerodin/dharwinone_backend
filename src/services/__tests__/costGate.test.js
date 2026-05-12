import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTranscriptTokens, applyCostGate } from '../summaryFinalize.service.js';

test('estimateTranscriptTokens approximates 4 chars per token', () => {
  const segs = [{ combinedText: 'a'.repeat(400) }];
  assert.equal(estimateTranscriptTokens(segs), 100);
});

test('applyCostGate rejects over MAX_TRANSCRIPT_TOKENS', () => {
  const res = applyCostGate({ estTokens: 999999, durationMinutes: 30 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /tokens/i);
});

test('applyCostGate rejects over MAX_MEETING_DURATION_MINUTES', () => {
  const res = applyCostGate({ estTokens: 100, durationMinutes: 9999 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /duration/i);
});

test('applyCostGate accepts normal case', () => {
  const res = applyCostGate({ estTokens: 5000, durationMinutes: 30 });
  assert.equal(res.ok, true);
});
