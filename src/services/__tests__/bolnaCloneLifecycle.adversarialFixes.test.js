import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __testables,
  canAttemptCleanup,
  isCleanupEligibleForSnapshot,
  isOrphanInitiationLifecycleRow,
  persistExecutionLogsArchive,
  decodeExecutionLogsArchive,
  attachExecutionLogsToSnapshot,
  isExecutionLogsDurablyCaptured,
  executionLogsBlockCleanup,
} from '../bolnaCloneLifecycle.service.js';

const { applyTerminalMarker, scheduleCleanupIfEligible, markCleanupAttemptsExhausted, workerLeaseMs } =
  __testables;

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
      eligible: true,
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

test('exhausted snapshot blocks cleanup by default', () => {
  const row = baseRow({
    state: 'snapshot_exhausted',
    snapshot: { ...baseRow().snapshot, status: 'exhausted' },
  });
  assert.equal(isCleanupEligibleForSnapshot(row, { allowCleanupOnSnapshotExhausted: false }), false);
  assert.equal(canAttemptCleanup(row, new Date()), false);
});

test('exhausted snapshot allows cleanup when policy env is enabled', () => {
  const row = baseRow({
    state: 'snapshot_exhausted',
    snapshot: { ...baseRow().snapshot, status: 'exhausted' },
  });
  assert.equal(isCleanupEligibleForSnapshot(row, { allowCleanupOnSnapshotExhausted: true }), true);
});

test('orphan failed-initiation rows remain cleanup-eligible when exhausted', () => {
  const row = baseRow({
    executionId: 'orphan:clone-9:123',
    state: 'snapshot_exhausted',
    snapshot: { ...baseRow().snapshot, status: 'exhausted', lastError: 'initiate_failed:dial' },
    terminal: { smartStatus: 'initiate_failed' },
  });
  assert.equal(isOrphanInitiationLifecycleRow(row), true);
  assert.equal(isCleanupEligibleForSnapshot(row, { allowCleanupOnSnapshotExhausted: false }), true);
});

test('scheduleCleanupIfEligible marks blocked cleanup when exhausted without policy', () => {
  const row = baseRow({
    snapshot: { ...baseRow().snapshot, status: 'exhausted' },
  });
  const scheduled = scheduleCleanupIfEligible(row, 'snapshot_exhausted_cleanup', new Date());
  assert.equal(scheduled, false);
  assert.equal(row.state, 'snapshot_exhausted');
  assert.equal(row.cleanup.status, 'blocked');
  assert.equal(row.cleanup.eligible, false);
  assert.equal(row.cleanup.blockedReason, 'snapshot_exhausted_retention_only');
});

test('execution logs are persisted compressed with retrieval pointer', () => {
  const raw = [
    { event: 'start', api_key: 'secret-1' },
    { event: 'end', authorization: 'Bearer x' },
  ];
  const archive = persistExecutionLogsArchive(raw);
  assert.ok(archive.data);
  assert.equal(archive.compression, 'gzip-base64');
  assert.equal(archive.redacted, true);
  assert.equal(archive.itemCount, 2);

  const decoded = decodeExecutionLogsArchive(archive);
  assert.equal(decoded[0].api_key, '[redacted]');
  assert.equal(decoded[1].authorization, '[redacted]');

  const row = baseRow();
  attachExecutionLogsToSnapshot(row, raw);
  assert.equal(row.snapshot.executionLogsArchive.sha256, archive.sha256);
  assert.equal(row.snapshot.payload.executionLogs.pointer, 'snapshot.executionLogsArchive');
  assert.equal(row.snapshot.payload.executionLogs.byteLength, archive.byteLength);
});

test('complete snapshot still allows cleanup after retention', () => {
  const row = baseRow({
    state: 'cleanup_pending',
    snapshot: { ...baseRow().snapshot, status: 'complete' },
  });
  assert.equal(canAttemptCleanup(row, new Date()), true);
});

test('partial snapshot never allows cleanup', () => {
  const row = baseRow({
    state: 'snapshot_partial',
    snapshot: { ...baseRow().snapshot, status: 'partial' },
  });
  assert.equal(canAttemptCleanup(row, new Date()), false);
});

test('terminal marker on complete snapshot schedules cleanup when retention passed', () => {
  const row = baseRow({
    snapshot: { ...baseRow().snapshot, status: 'complete' },
    cleanup: {
      status: 'pending',
      eligible: true,
      attempts: 0,
      maxAttempts: 6,
      deleteEligibleAt: new Date(Date.now() - 1000),
      nextRetryAt: null,
    },
  });
  applyTerminalMarker(row, { status: 'completed', eventId: 'evt-1', eventTs: new Date() }, 'terminal');
  assert.equal(row.state, 'cleanup_pending');
});

test('truncated execution logs block cleanup until durable capture exists', () => {
  const archive = {
    storage: 'inline',
    compression: 'gzip-base64',
    truncated: true,
    captureRequired: true,
    captureStatus: 'truncated_requires_manual',
    data: null,
    byteLength: 4 * 1024 * 1024 + 1,
  };
  assert.equal(isExecutionLogsDurablyCaptured(archive), false);

  const row = baseRow({
    state: 'snapshot_complete',
    snapshot: {
      ...baseRow().snapshot,
      status: 'complete',
      executionLogsArchive: archive,
    },
  });
  assert.equal(executionLogsBlockCleanup(row), true);
  const scheduled = scheduleCleanupIfEligible(row, 'snapshot_complete_cleanup', new Date());
  assert.equal(scheduled, false);
  assert.equal(canAttemptCleanup(row, new Date()), false);
  assert.equal(row.cleanup.status, 'blocked');
  assert.equal(row.cleanup.blockedReason, 'execution_logs_not_durable');
});

test('scheduleCleanupIfEligible refuses cleanup when execution logs are not durable', () => {
  const row = baseRow({
    snapshot: {
      ...baseRow().snapshot,
      status: 'complete',
      executionLogsArchive: {
        storage: 'inline',
        truncated: true,
        captureRequired: true,
        data: null,
      },
    },
  });
  const scheduled = scheduleCleanupIfEligible(row, 'snapshot_complete_cleanup', new Date());
  assert.equal(scheduled, false);
  assert.equal(row.cleanup.blockedReason, 'execution_logs_not_durable');
});

test('cleanup attempts at maxAttempts cannot be claimed or retried', () => {
  const row = baseRow({
    state: 'cleanup_pending',
    snapshot: { ...baseRow().snapshot, status: 'complete' },
    cleanup: {
      status: 'retrying',
      eligible: true,
      attempts: 6,
      maxAttempts: 6,
      deleteEligibleAt: new Date(Date.now() - 1000),
      nextRetryAt: null,
    },
  });
  assert.equal(canAttemptCleanup(row, new Date()), false);

  const now = new Date();
  markCleanupAttemptsExhausted(row, now);
  assert.equal(row.cleanup.status, 'blocked');
  assert.equal(row.cleanup.blockedReason, 'cleanup_attempts_exhausted');
  assert.equal(row.cleanup.eligible, false);
});

test('worker lease expiry is computed per batch claim iteration', () => {
  const leaseMs = workerLeaseMs({ workerLeaseSeconds: 120 });
  const t0 = Date.now();
  const claimNow = new Date(t0 + 5000);
  const leaseExpiresAt = new Date(claimNow.getTime() + leaseMs);
  assert.ok(leaseExpiresAt.getTime() > t0 + leaseMs);
  assert.equal(leaseExpiresAt.getTime() - claimNow.getTime(), leaseMs);
});

test('terminal marker does not reopen cleanup blocked after attempts exhausted', () => {
  const now = new Date();
  const row = baseRow({
    state: 'cleanup_pending',
    snapshot: { ...baseRow().snapshot, status: 'complete' },
    cleanup: {
      status: 'blocked',
      eligible: false,
      blockedReason: 'cleanup_attempts_exhausted',
      attempts: 6,
      maxAttempts: 6,
      deleteEligibleAt: new Date(Date.now() - 1000),
      nextRetryAt: null,
      lastError: 'cleanup_attempts_exhausted',
    },
    terminal: { eventId: 'evt-old', status: 'completed' },
  });

  applyTerminalMarker(
    row,
    { status: 'completed', smartStatus: 'completed', eventId: 'evt-new', eventTs: now },
    'terminal_event'
  );

  assert.equal(row.cleanup.status, 'blocked');
  assert.equal(row.cleanup.blockedReason, 'cleanup_attempts_exhausted');
  assert.equal(row.cleanup.eligible, false);
  assert.equal(row.state, 'cleanup_pending');
  assert.equal(row.terminal.eventId, 'evt-new');
});
