import { test } from 'node:test';
import assert from 'node:assert/strict';
import Summary from '../summary.model.js';

test('Summary requires meetingId', () => {
  const s = new Summary({});
  const err = s.validateSync();
  assert.ok(err);
  assert.ok(err.errors.meetingId);
});

test('Summary accepts full structured payload', () => {
  const s = new Summary({
    meetingId: 'meeting_abc',
    executiveSummary: 'Met today.',
    bulletSummary: ['a', 'b'],
    actionItems: [{ text: 'Ship spec', owner: 'alice', dueHint: 'Friday', timestampMs: 1200 }],
    decisions: [{ text: 'Use Python agent', timestampMs: 800 }],
    blockers: ['x'],
    nextSteps: ['y'],
    participantsActive: [{ identity: 'u_1', name: 'Alice', speakingMs: 60000 }],
    durationMs: 1800000,
    llmCostUsd: 0.012,
    version: 1,
    partial: false,
  });
  assert.equal(s.validateSync(), undefined);
});

test('Summary defaults', () => {
  const s = new Summary({ meetingId: 'meeting_abc' });
  assert.equal(s.version, 1);
  assert.equal(s.partial, false);
  assert.equal(s.llmModelMix, 'gpt-4o-mini+gpt-4o');
});
