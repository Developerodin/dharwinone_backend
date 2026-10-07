# Bolna Clone Lifecycle

This backend treats per-call Bolna clone agents as a durable lifecycle, not an immediate delete side effect.

## State Machine

- `initiated`: clone call seeded at call-initiate time.
- `terminal_event_seen`: a terminal call event arrived.
- `snapshot_pending` / `snapshot_partial`: async snapshot worker is fetching eventual-consistency artifacts from Bolna.
- `snapshot_complete`: all tracked forensic sections are present.
- `snapshot_exhausted`: snapshot retries hit max attempts; missing sections are persisted in `snapshot.missingSections`.
- `cleanup_pending`: clone is waiting for retention gate and cleanup retries (`cleanup.status` is `pending` or `retrying`).
- `cleaned`: clone deletion completed (or deletion skipped because the id was template/shared).

`cleanup.status` may also be `blocked` while the row remains in `cleanup_pending` (or `snapshot_exhausted`): cleanup will not be retried until an operator intervenes.

## Cleanup Gating Rules

Clone delete is attempted only when all are true:

1. row is in `cleanup_pending`
2. `cleanup.status` is not `blocked`
3. retention window reached (`cleanup.deleteEligibleAt`)
4. retry window reached (`cleanup.nextRetryAt`)
5. snapshot status is `complete`, or `exhausted` when policy allows (`allowCleanupOnSnapshotExhausted` or orphan-initiation rows)
6. execution logs archive gate passes (when capture is required)

## Periodic Tick (`runBolnaCloneLifecycleTick`)

Each call-sync cron pass runs, in order:

1. **Repair** — `repairMissingLifecycleRows`: oldest `CallRecord` rows with `ownedClone`, valid `executionId`/`agentId`, and no lifecycle row yet (age ≥ repair minimum).
2. **Snapshots** — due snapshot retries (skipped when Bolna API key is absent).
3. **Cleanup** — due clone deletes.
4. **Stale cleanup finalize** — `finalizeStaleExhaustedCleanupRows`: rows still `cleanup_pending` with `cleanup.status` `pending`/`retrying`, attempts ≥ `maxAttempts`, and `nextRetryAt` older than `staleCleanupRetryResetMinutes` (or null) are marked `cleanup.status=blocked`, `blockedReason=cleanup_attempts_exhausted`, `eligible=false` (not requeued).

Metrics: `repaired`, `snapshots`, `cleanup`, `staleCleanupBlocked.blocked`.

## Failure Modes

- **Late Bolna artifacts**: handled by bounded backoff retries.
- **Permanent missing artifacts**: row becomes `snapshot_exhausted` with section-level markers.
- **Delete failures**: `cleanup.status=retrying` with bounded exponential backoff until `maxAttempts`.
- **Stale retry exhaustion**: after the stale window, `finalizeStaleExhaustedCleanupRows` finalizes the row as `cleanup.status=blocked` / `cleanup_attempts_exhausted` (no automatic requeue).
- **Snapshot exhausted, cleanup not allowed**: `cleanup.status=blocked` / `snapshot_exhausted_retention_only`.
- **Execution logs not durably captured**: `cleanup.status=blocked` / `execution_logs_not_durable`.
- **Missing lifecycle rows for old owned clones**: periodic repair pass backfills from `CallRecord`.

## Operator Runbook (blocked cleanup)

| `cleanup.blockedReason` | Meaning | Typical action |
| --- | --- | --- |
| `cleanup_attempts_exhausted` | Delete retries hit max and stale finalize ran | Inspect `cleanup.lastError`; delete clone in Bolna if still present; mark row `cleaned` or adjust data and clear block if retry is warranted |
| `snapshot_exhausted_retention_only` | Snapshot exhausted and policy blocks delete | Retain clone for audit; no automatic delete |
| `execution_logs_not_durable` | Required execution logs never landed durably | Fix snapshot/archive data or waive gate; then unblock or seed logs before cleanup |

Query examples: `state: cleanup_pending`, `cleanup.status: blocked`, or filter by `blockedReason`.

## Data Safety

- Prompt snapshots and Bolna payloads are persisted for forensic audit.
- Known credential-like keys (`token`, `secret`, `api_key`, `authorization`, etc.) are redacted before persistence.

## Indexes (CallRecord repair scan)

Repair aggregation matches `ownedClone: true`, `createdAt` ≤ cutoff, non-empty `executionId`/`agentId`, then sorts `{ createdAt: 1, _id: 1 }`. A partial compound index on `callrecords` supports this path; see `callRecord.model.js`. Production `autoIndex` is off — create the index on deploy (see `config.js` / `MONGOOSE_AUTO_INDEX`).
