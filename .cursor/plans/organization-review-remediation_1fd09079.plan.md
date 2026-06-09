---
name: organization-review-remediation
overview: Append review-driven remediation to the Organization module plan so implementation includes RBAC alignment, scoped reads, safe sync boundaries, and branch scope hygiene.
todos:
  - id: fix-auth-boundary
    content: Align employee PATCH route/service authorization and add onboarding mutation regression tests
    status: pending
  - id: fix-org-visibility
    content: Add actor/visibility scoping to orgStructure and department read services
    status: pending
  - id: fix-sync-boundaries
    content: Guard joiningDate/designation cross-entity sync behind explicit intent + permission checks
    status: pending
  - id: fix-position-upsert
    content: Replace find-then-create with atomic upsert for position resolution
    status: pending
  - id: split-non-org-changes
    content: Move unrelated ATS/attendance/recording/timezone changes to separate branch/PR
    status: pending
  - id: reverify-org-plan
    content: Re-run org module verification with new security and regression gates
    status: pending
isProject: false
---

# Organization Module Plan Update (Review Fixes)

## What This Update Changes

This addendum keeps the existing Organization module scope, but adds mandatory hardening work from the branch review so the rollout is compliant and safe.

## Required Fix Tracks

### 1) Authorization Boundary Alignment

- Align route and service authorization for employee/candidate PATCH:
  - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/routes/v1/employee.route.js`
  - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/employee.service.js`
- Choose one explicit model:
  - **Model A:** narrow route perms back to mutation roles only, or
  - **Model B:** keep onboarding route access but enforce a strict onboarding field-allowlist in service.
- Add regression tests to prove onboarding-scoped users cannot perform broad candidate mutations.

### 2) Organization Data Visibility Scoping

- Prevent global organization metadata enumeration by adding actor/visibility scoping to organization reads:
  - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgStructure.service.js`
  - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/department.service.js`
- Reuse existing backend visibility patterns already used in ATS read flows (same guard philosophy).
- Verify chart/structure/department responses remain correct for authorized users while restricted for scoped roles.

### 3) Cross-Entity Sync Safety

- Gate high-impact propagation in employee update paths so generic PATCH does not silently mutate accepted-offer canon:
  - `joiningDate` propagation (`Offer` + `Placement` sync)
  - `designation` to `positionTitle` propagation
  - Files:
    - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/employee.service.js`
    - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/offer.service.js`
- Introduce explicit intent checks and permission checks before any cross-document write.

### 4) Concurrency Hardening (Position Upsert)

- Remove find-then-create race window for position resolution by using atomic upsert semantics:
  - `C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/offer.service.js`
  - Any equivalent helper in `employee.service.js`
- Ensure normalized title uniqueness is enforced consistently.

### 5) Scope Hygiene for This Delivery

- Split non-organization changes into separate PR/branch tracks (salary filter, ATS analytics leaderboard, attendance punch policy changes, recording perms refactor, internal meeting timezone changes).
- Keep this organization PR focused on hierarchy + department governance + compliance checks.

## Execution Order (Delta)

1. Authorization boundary alignment
2. Visibility scoping in organization services
3. Cross-entity sync guards
4. Atomic upsert hardening
5. Re-run org module verification + permission regression suite
6. Branch/PR scope cleanup

## Additional Verification Gates

- Onboarding-scoped user can update allowed onboarding fields but cannot trigger broad candidate mutation.
- Org endpoints do not return out-of-scope units/departments for restricted actors.
- Generic employee edit does not mutate accepted offer/placement data unless explicitly authorized.
- Concurrent designation/position updates do not create duplicate/inconsistent position rows.

## Definition of Done (Updated)

Organization module rollout is complete only when:
- hierarchy/compliance features are functional,
- review findings above are resolved,
- regression tests for permissions + sync boundaries are green,
- unrelated changes are moved out of the organization delivery PR.