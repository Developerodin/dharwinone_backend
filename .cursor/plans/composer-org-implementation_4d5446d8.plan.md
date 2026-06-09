---
name: composer-org-implementation
overview: Composer-ready execution plan to implement the Organization Compliance Master scope with phased delivery, strict security gates, and verification checkpoints.
todos:
  - id: phase0-scope-control
    content: Isolate organization-only scope and move unrelated changes to separate branches
    status: completed
  - id: phase1-auth-alignment
    content: Align employee PATCH route/service authorization with explicit allowed mutation model
    status: completed
  - id: phase1-org-scoping
    content: Apply actor/visibility scoping to org structure and department read paths
    status: completed
  - id: phase1-sync-safety
    content: Guard joiningDate/designation cross-entity propagation by explicit intent and permission
    status: completed
  - id: phase1-position-upsert
    content: Implement atomic upsert for position resolution under concurrent writes
    status: completed
  - id: phase2-hierarchy-rules
    content: Implement and enforce hierarchy placement validation in create/update/reparent
    status: completed
  - id: phase2-employee-edit-dept
    content: Add managed department assignment to employee edit flow
    status: completed
  - id: phase2-head-display
    content: Include and render named org unit heads in backend DTO and frontend chart
    status: completed
  - id: phase2-coverage-summary
    content: Add coverage summary endpoint and unassigned-focused UI metrics
    status: completed
  - id: phase3-setup-checklist
    content: Implement guided setup checklist in structure UI
    status: completed
  - id: phase3-dept-governance
    content: Enforce permission-based inline department creation governance
    status: completed
  - id: phase3-compliance-export
    content: Implement compliance export/report endpoint and UI trigger
    status: completed
  - id: phase4-verification
    content: Run full auth/scoping/sync/concurrency and org-flow verification, then finalize
    status: completed
isProject: false
---

# Composer Implementation Plan — Organization Compliance

## Implementation Intent

Implement the Organization module end-to-end by combining feature delivery and hardening work in one controlled sequence:
- deliver compliance features,
- close review findings,
- keep branch scope clean,
- verify with regression gates before completion.

**Implementation owner:** Composer model is the designated implementer for this plan.

## Phase 0 — Branch and Scope Control

- Start from `feature/organization-module` and keep only organization-related changes in this PR scope.
- Move unrelated work (salary filters, ATS analytics leaderboard, attendance policy changes, recording policy refactor, internal meeting timezone formatting) to separate branches.
- Establish one source checklist for completion using this plan.

Target files:
- `src/services/orgStructure.service.js`
- `src/services/department.service.js`
- `src/services/orgTree.pure.js`
- `src/services/employee.service.js`
- `src/services/offer.service.js`
- `src/routes/v1/employee.route.js`
- organization frontend pages/components and employee edit form

## Phase 1 — Security/Correctness Hardening First

### 1.1 Authorization Boundary Alignment

- Align route-level and service-level authorization for employee/candidate PATCH.
- Decide one explicit policy:
  - narrow PATCH permissions to mutation roles, or
  - allow onboarding roles but strictly allowlist editable fields in service.
- Ensure no onboarding-scoped actor can trigger broad candidate mutations.

Files:
- `src/routes/v1/employee.route.js`
- `src/services/employee.service.js`

### 1.2 Organization Read Scoping

- Add actor/visibility scoping to organization read paths to prevent global enumeration.
- Apply to tree/list/department reads while preserving authorized admin views.

Files:
- `src/services/orgStructure.service.js`
- `src/services/department.service.js`

### 1.3 Cross-Entity Sync Safety

- Guard high-impact sync logic (`joiningDate`, `designation -> positionTitle`) behind explicit intent + permission checks.
- Prevent generic employee edit from silently mutating accepted offer/placement canonical fields.

Files:
- `src/services/employee.service.js`
- `src/services/offer.service.js`

### 1.4 Atomic Upsert for Position Resolution

- Replace find-then-create logic with atomic upsert semantics for position records.
- Ensure normalized uniqueness and deterministic linking under concurrent writes.

Files:
- `src/services/offer.service.js`
- any equivalent helper in `src/services/employee.service.js`

## Phase 2 — Core Compliance Feature Delivery

### 2.1 Hierarchy Rule Enforcement

- Enforce allowed parent-child rules:
  - `ceo -> manager -> supervisor -> department`
  - `ceo -> department` only when direct-to-CEO rule applies.
- Enforce rules in create/update/reparent flows and block invalid transitions.

Files:
- `src/services/orgTree.pure.js`
- `src/services/orgStructure.service.js`
- org structure validators/controllers/routes as needed

### 2.2 Employee Edit Department Assignment

- Add managed `departmentId` dropdown to employee edit form.
- Load canonical departments and submit `departmentId` in admin/manager edit path.
- Preserve compatibility with legacy `department` string dual-write behavior.

Files:
- `uat.dharwin.frontend/shared/data/pages/candidates/candidateform.tsx`
- `uat.dharwin.frontend/app/(components)/(contentlayout)/ats/employees/edit/page.tsx`
- related frontend API types/adapters

### 2.3 Named Heads in Tree/Chart

- Return head employee details in org tree payload.
- Render head names and context in chart and structure views.

Files:
- `src/services/orgStructure.service.js`
- `uat.dharwin.frontend/shared/lib/api/org-structure.ts`
- chart/structure components

### 2.4 Coverage Summary + Unassigned Metrics

- Add coverage endpoint and compute:
  - total active employees,
  - assigned vs unassigned,
  - departments without nodes,
  - nodes without employees,
  - units without heads.
- Show actionable cards in UI.

Files:
- `src/services/orgStructure.service.js`
- org chart page/components

## Phase 3 — Governance and Admin UX

### 3.1 Setup Checklist

- Add guided setup checklist in structure page:
  - create CEO,
  - add manager/supervisor chain,
  - link departments,
  - assign heads,
  - resolve unassigned employees.

Files:
- organization structure page and related components

### 3.2 Department Governance

- Restrict inline department creation by organization department permissions.
- Keep department creation authority anchored to department management permissions.

Files:
- onboarding/edit form components
- permission checks in frontend + backend route guards

### 3.3 Compliance Export

- Add export/report endpoint with hierarchy + assignment evidence including unassigned list.
- Add “Export compliance report” button in organization UI.

Files:
- org structure controller/service/routes
- org chart/structure UI

## Phase 4 — Verification and Release Readiness

- Run backend tests for hierarchy rules, service guards, and sync behavior.
- Validate auth regression scenarios:
  - onboarding-scoped user cannot mutate out-of-scope fields,
  - restricted users do not receive globally scoped org data.
- Validate concurrency behavior of position upsert path.
- Validate org flows manually:
  - build hierarchy,
  - assign heads,
  - assign departments from onboarding and employee edit,
  - verify chart placement and unassigned movement,
  - verify export output.
- Update graph index after backend code changes (`graphify update .`).

## Composer Execution Rules

- Complete phases in order (hardening before feature expansion).
- Do not mix unrelated module changes into this PR.
- Keep each phase shippable and testable.
- If policy ambiguity arises (permission model choice), stop and request one explicit decision before continuing.

## Done Criteria

Implementation is complete only when:
1. all hardening items are closed,
2. all compliance features are delivered,
3. regressions pass for auth/scoping/sync/concurrency,
4. org PR is scope-clean and focused.