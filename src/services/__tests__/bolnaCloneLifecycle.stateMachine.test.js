import test from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../bolnaCloneLifecycle.service.js';

const {
  computeBackoffMs,
  deriveSnapshotCompleteness,
  canAttemptCleanup,
  applyTerminalMarker,
} = __testables;

function baseRow(overrides = {}) {
  return {
    executionId: 'exec-1',
    cloneAgentId: 'clone-1',
    state: 'initiated',
    snapshot: {
      status: 'pending',
      attempts: 0,
      maxAttempts: 8,
      nextRetryAt: null,
      completeness: {},
      payload: {},
      missingSections: [],
    },
    cleanup: {
      status: 'pending',
      attempts: 0,
      maxAttempts: 6,
      deleteEligibleAt: new Date(Date.now() - 1000),
      nextRetryAt: null,
    },
    terminal: {},
    audit: {},
    ...overrides,
  };
}

test('retry backoff grows and caps', () => {
  const first = computeBackoffMs(1, 30, 1800);
  const second = computeBackoffMs(2, 30, 1800);
  const tenth = computeBackoffMs(10, 30, 1800);
  assert.equal(first, 30000);
  assert.equal(second, 60000);
  assert.equal(tenth, 1800000);
});

test('cleanup is blocked until snapshot is complete (exhausted alone is not enough by default)', () => {
  const row = baseRow({
    state: 'cleanup_pending',
    snapshot: {
      status: 'partial',
      attempts: 1,
      maxAttempts: 8,
      nextRetryAt: null,
      completeness: {},
      payload: {},
      missingSections: ['transcript'],
    },
  });
  assert.equal(canAttemptCleanup(row, new Date()), false);
  row.snapshot.status = 'exhausted';
  assert.equal(canAttemptCleanup(row, new Date()), false);
  row.snapshot.status = 'complete';
  assert.equal(canAttemptCleanup(row, new Date()), true);
});

test('disconnected terminal marks snapshot_pending and respects retention gate', () => {
  const row = baseRow({
    cleanup: {
      status: 'pending',
      attempts: 0,
      maxAttempts: 6,
      deleteEligibleAt: new Date(Date.now() + 60 * 60 * 1000),
      nextRetryAt: null,
    },
  });
  applyTerminalMarker(
    row,
    { status: 'call_disconnected', smartStatus: 'call-disconnected', eventId: 'evt-1', eventTs: new Date() },
    'test'
  );
  assert.equal(row.state, 'snapshot_pending');
  assert.ok(row.snapshot.nextRetryAt instanceof Date);
  // Even if snapshot is ready, retention window still blocks cleanup.
  row.snapshot.status = 'complete';
  assert.equal(canAttemptCleanup(row, new Date()), false);
});

test('duplicate terminal markers do not regress lifecycle state', () => {
  const row = baseRow({
    state: 'cleanup_pending',
    snapshot: {
      status: 'complete',
      attempts: 3,
      maxAttempts: 8,
      nextRetryAt: null,
      completeness: deriveSnapshotCompleteness({
        callCore: { callId: 'c1', status: 'completed' },
        telephony: { recordingUrl: 'https://example.com/r.wav' },
        transcript: { transcript: 'hello' },
        extracted: { extractedData: { availability: 'yes' } },
        context: { recipientData: { name: 'Ada' } },
        costUsage: { cost: { total: 1.2 } },
        agentMetadata: { agentId: 'clone-1', agentVersionId: 'v1' },
        promptSnapshot: { hash: 'abc' },
      }),
      payload: {},
      missingSections: [],
    },
  });

  applyTerminalMarker(row, { status: 'completed', eventId: 'evt-2', eventTs: new Date() }, 'terminal');
  const stateAfterFirst = row.state;
  const attemptsAfterFirst = row.snapshot.attempts;
  applyTerminalMarker(row, { status: 'completed', eventId: 'evt-2', eventTs: new Date() }, 'terminal');

  assert.equal(stateAfterFirst, 'cleanup_pending');
  assert.equal(row.state, 'cleanup_pending');
  assert.equal(row.snapshot.attempts, attemptsAfterFirst);
});
