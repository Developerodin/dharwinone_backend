---
name: organization-compliance-master
overview: Unified master plan for Organization module delivery that merges feature scope from the original compliance plan with mandatory security/reliability fixes from the review remediation plan.
todos:
  - id: auth-boundary-alignment
    content: Align employee PATCH route and service authorization with explicit allowed mutation model
    status: pending
  - id: org-read-scoping
    content: Apply actor/visibility scoping to orgStructure and department read services
    status: pending
  - id: cross-entity-sync-guards
    content: Gate joiningDate/designation propagation by explicit intent and permission checks
    status: pending
  - id: position-atomic-upsert
    content: Replace find-then-create position resolution with atomic upsert path
    status: pending
  - id: hierarchy-rule-enforcement
    content: Implement hierarchy rule validators and enforce in create/update/reparent flows
    status: pending
  - id: employee-edit-department
    content: Add managed department selector to employee edit and wire departmentId payload
    status: pending
  - id: head-display
    content: Return head employee DTO in tree and render named heads in org chart/structure
    status: pending
  - id: coverage-summary
    content: Implement coverage summary endpoint and frontend cards with actionable unassigned metric
    status: pending
  - id: setup-checklist
    content: Add guided setup checklist with links/actions for org configuration
    status: pending
  - id: department-governance
    content: Restrict inline department creation by organization department permissions
    status: pending
  - id: compliance-export
    content: Add export/report endpoint and chart UI action for compliance evidence
    status: pending
  - id: regression-suite
    content: Run and pass auth/scoping/sync/concurrency and org-flow regression validation
    status: pending
  - id: scope-hygiene
    content: Split unrelated non-org changes into separate branch/PRs before final signoff
    status: pending
isProject: false
---

# Organization Compliance Master Plan

## Goal

Deliver the Organization module as a compliance-ready feature set while closing the review findings on authorization boundaries, data visibility scoping, cross-entity mutation safety, and concurrency reliability.

## In-Scope Workstreams

### Workstream A — Core Organization Features (from original plan)

1. Enforce hierarchy rules (CEO -> Manager -> Supervisor -> Department -> Employees, with direct-to-CEO department exception).
2. Add managed department assignment in employee edit flow.
3. Return and render named heads for org units in chart/structure.
4. Add coverage summary and actionable unassigned metrics.
5. Add guided setup checklist for org configuration.
6. Enforce department governance for inline department creation.
7. Add compliance export/report endpoint and UI action.

Primary files:
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgTree.pure.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgTree.pure.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgStructure.service.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgStructure.service.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/department.service.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/department.service.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.frontend/app/(components)/(contentlayout)/organization/chart/page.tsx](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.frontend/app/(components)/(contentlayout)/organization/chart/page.tsx)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.frontend/app/(components)/(contentlayout)/organization/structure/page.tsx](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.frontend/app/(components)/(contentlayout)/organization/structure/page.tsx)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.frontend/shared/data/pages/candidates/candidateform.tsx](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.frontend/shared/data/pages/candidates/candidateform.tsx)

### Workstream B — Mandatory Review Remediation (from remediation plan)

1. Align route-level and service-level authorization for employee/candidate PATCH.
2. Add actor/visibility scoping for organization read surfaces.
3. Guard cross-entity sync so generic PATCH cannot silently mutate accepted-offer canon.
4. Replace find-then-create position resolution with atomic upsert semantics.
5. Split unrelated changes from org delivery branch/PR.

Primary files:
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/routes/v1/employee.route.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/routes/v1/employee.route.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/employee.service.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/employee.service.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/offer.service.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/offer.service.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgStructure.service.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/orgStructure.service.js)
- [C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/department.service.js](C:/Users/INTEL/Desktop/DHARWIN NEW/uat.dharwin.backend/src/services/department.service.js)

## Unified Execution Order

### Phase 1 — Hardening First

1. Authorization boundary alignment (route/service consistency).
2. Organization read visibility scoping.
3. Cross-entity sync intent and permission gates.
4. Atomic upsert for position resolution.

### Phase 2 — Compliance Feature Completion

5. Hierarchy placement validation (backend + guided frontend parent filtering).
6. Employee edit department dropdown and payload wiring.
7. Named head data in DTO + chart rendering.
8. Coverage summary endpoint + cards.

### Phase 3 — Admin UX and Governance

9. Setup checklist and deep links.
10. Department governance for inline creation permissions.
11. Compliance export/report endpoint + UI button.

### Phase 4 — Stabilization and Delivery Hygiene

12. Regression suite for auth/scoping/sync/concurrency.
13. Separate unrelated ATS/attendance/recording/timezone changes into dedicated PR(s).
14. Final org-focused verification and signoff.

## Verification Gates

- Onboarding-scoped users cannot perform broad candidate mutations.
- Organization endpoints do not globally enumerate units/departments for restricted actors.
- Generic employee edits do not mutate accepted offer/placement canon unless explicitly authorized.
- Concurrent designation/position writes do not create inconsistent position links.
- Org chart completeness checks pass: each active employee appears under department node or in unassigned.
- Invalid hierarchy moves are blocked in UI guidance and API enforcement.
- Department creation controls follow organization department permissions.
- Compliance export contains hierarchy, department mapping, and unassigned evidence.

## Definition of Done

The module is complete only when:
1. All Workstream A features are implemented and verified.
2. All Workstream B remediation items are closed.
3. Regression checks for auth/scoping/sync/concurrency pass.
4. Org delivery PR contains only organization-related changes.
5. Final manual validation of chart, structure, departments, onboarding, and employee edit flows succeeds.