# Organization Audit Runbook

This runbook is the operating guide for the organization audit work planned in `org_module_master_plan_3f16b17c.plan.md`.

## Scope

Use this runbook for:

- Verifying organization, department, employee department assignment, denied mutation, and export audit rows.
- Debugging missing or malformed organization `ActivityLog` rows.
- Reconciling failed audit writes after the business mutation already succeeded.
- Confirming tenant, request-context, and append-only evidence assumptions before release.

Not in scope:

- General ActivityLog maintenance outside organization evidence.
- Matrix reporting or scenario sandbox operations before those phases ship.
- PDF/PNG export fidelity debugging; CSV is the large-org source of truth.

## Pre-Release Gates

Before Phase 1A ships:

1. Prove whether org catalogs and audit evidence are global or tenant-scoped in production.
2. Verify Mongo topology/capability assumptions before choosing transaction, versioned, or atomic update patterns.
3. Confirm trusted proxy/header policy for IP/geo metadata.
4. Confirm the ops fallback path:
   - Full metrics/dashboard/alert/replay stack if available.
   - Otherwise structured logs plus persisted unreconciled audit-outbox/reconciliation rows.
5. Confirm `ActivityLog` evidence is append-only and corrections are additive.

## Staging Verification

Run this sequence as an HR admin in staging and link the result in the implementation PR or release note.

1. Create an org unit with parent and head.
   - Expect `orgUnit.create` on `OrgUnit`.
   - Metadata includes actor, entityId, `fieldsUpdated`, `parentIdAfter`, `headEmployeeIdAfter`, IP, and geo source.
2. Update the org unit with no effective change.
   - Expect no empty audit row.
3. Reparent the org unit.
   - Expect `orgUnit.reparent`.
   - Metadata includes `parentIdBefore`, `parentIdAfter`, and impact summary fields.
4. Assign or clear the head.
   - Expect `orgUnit.headAssign` or `orgUnit.headClear`.
   - Metadata includes before/after employee IDs.
5. Create or update a department.
   - Expect matching `department.*` action with ID-only before/after metadata.
6. Assign an employee to a department.
   - Expect `employee.departmentAssign`.
   - Confirm no blank `candidate.update {}` audit row is created.
7. Download CSV export.
   - Expect `orgStructure.export`.
   - Metadata includes `format`, `rowCount`, `employeeCount`, and `outcome`.
8. Attempt one unauthorized org write/export.
   - Expect existing authorization error to remain visible.
   - Expect `org.mutate.denied` with only allowlisted metadata.

## Expected Evidence Shape

Each successful organization audit row should answer:

- Who acted: `actorId` and display fields already allowed by ActivityLog.
- What changed: action, entity type, entity id, and safe summary metadata.
- When it happened: `occurredAt` for the business event and `recordedAt` for the audit write when reconciliation is involved.
- Where it came from: request route, requestId, IP/geo source labels where available.
- How much changed: compact impact summary for reparent/head changes.

Denied rows must never include:

- Raw request body.
- Attempted field values.
- Email or phone.
- Passwords, tokens, or nested payload objects.
- Arbitrary names from the denied request.

## Missing Audit Row Triage

Use this order:

1. Confirm the business mutation succeeded.
2. Check controller logs for fail-soft audit wrapper errors.
3. Check unreconciled audit-outbox/reconciliation rows for matching action, entity, route, requestId, and actor.
4. Check whether the audit envelope was `null` because the service detected a no-op.
5. Check whether tenant filters hide the row from the current viewer.
6. Check frontend catalog parity if the row exists but displays as an unknown/raw action.
7. Check permission-denial aggregation if the missing row is a repeated denied request.

## Reconciliation Workflow

When audit persistence fails after mutation commit:

1. Do not roll back the successful business mutation.
2. Persist non-sensitive retry context in the reconciliation path.
3. Retry according to the configured cadence and max attempts.
4. Keep unreconciled rows visible to ops until replay succeeds or is explicitly closed.
5. Replayed audit rows must preserve original `occurredAt` and use current `recordedAt`.
6. Corrections must be additive rows that reference the original audit row or reconciliation id.

Do not mark Phase 1A complete while unreconciled organization audit failures remain.

## Release Evidence Checklist

- [ ] Tenant evidence gate recorded.
- [ ] Mongo capability gate recorded.
- [ ] Trusted proxy/IP/geo policy recorded.
- [ ] Append-only/correction-row policy tested.
- [ ] Denied audit allowlist and abuse controls tested.
- [ ] Backend/frontend catalog parity tested.
- [ ] Structure History and export smoke tested.
- [ ] Staging verification sequence linked from PR or release note.
- [ ] Unreconciled audit failure count is zero at release.
