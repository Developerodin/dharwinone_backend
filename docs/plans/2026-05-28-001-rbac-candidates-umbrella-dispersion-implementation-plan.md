# RBAC Candidates Umbrella Dispersion Implementation Plan

**Status:** Ready for implementation review  
**Date:** 2026-05-28  
**Repos:** `uat.dharwin.backend`, `uat.dharwin.frontend`  
**Related docs:**
- `docs/RBAC_CANDIDATES_DISPERSION_PLAN.md`
- `docs/RBAC_HARDCODED_SCOPE_AUDIT.md`

---

## Objective

Disperse the legacy ATS Candidates umbrella permission so each role-matrix row controls its own page, API route, action buttons, and data scope.

The legacy `ats.candidates:*` / `candidates.read|manage` permissions must stop granting unrelated ATS access such as referral leads, offers, pre-boarding, job applications, analytics, settings, uploads, PM assistant, teams photos, and notification audit.

Hardcoded role-name access may remain only for genuinely admin or superadmin surfaces:

- `platformSuperUser`
- designated superadmin-only paths
- explicitly admin-only operational routes where the product contract is "admin-only"

Every other business feature must be governed by matrix permissions.

---

## Non-negotiable migration contract

1. Do not add target permissions to the global `candidates.read` / `candidates.manage` aliases.
   - Bad: `candidates.read` accepts `referralLeads.read`, `offers.read`, or `pre-boarding.read`.
   - Good: the referral route uses `requireAnyOfPermissions('referralLeads.read', 'candidates.read')` during transition.

2. Use route-local legacy bridges only.
   - Each migrated route should accept the target permission plus legacy Candidates for one release.
   - After DB migration and QA, remove the legacy bridge on that specific route.

3. Data scope must use the same owner key as the route.
   - Route access and list visibility must not drift.
   - If `offers.manage` opens the Offers page, `queryOffers` must honor `offers.manage`.

4. View and manage must be intentionally scoped.
   - `*.read` decides whether a user can view the page/list.
   - `*.manage`, or explicit `*.create|edit|delete`, decides write and org-wide mutating power.
   - Do not let view-only silently become full org-wide write.

5. Keep `ats.candidates` as a deprecated compatibility row until the final phase.
   - Do not delete it first.
   - First migrate live roles to granular rows, prove target-only roles work, then remove the Candidates row/backstops.

---

## Phase 0: Documentation and API discovery

### Sources already verified

- Backend alias expansion: `src/config/permissions.js`
- Generic derivation: `src/services/permission.service.js`
- Route guards: `src/middlewares/requirePermissions.js`
- Permission check helper: `src/utils/permissionCheck.js`
- Backend semantic actions: `src/config/actionPermissions.js`
- Frontend matrix rows: `uat.dharwin.frontend/shared/lib/roles-permissions.ts`
- Frontend route gates: `uat.dharwin.frontend/shared/lib/route-permissions.ts`
- Frontend semantic actions: `uat.dharwin.frontend/shared/lib/permissions.ts`
- Legacy frontend helpers: `uat.dharwin.frontend/shared/lib/candidate-permissions.ts`

### Allowed implementation APIs

- Use `requirePermissions(requiredKey)` when a route has one canonical owner.
- Use `requireAnyOfPermissions(targetKey, legacyKey)` for one-release compatibility bridges.
- Use `hasApiPermissionFromContext(req.authContext?.permissions, req.user?.platformSuperUser, key)` inside controllers/services when the request context is available.
- Use `hasApiPermission(user, key)` only in service code where no `req.authContext` exists.
- Keep using `deriveApiPermissions()` as-is. It already derives:
  - `ats.referralLeads:view` -> `referralLeads.read`
  - `ats.offers:create,edit,delete` -> `offers.manage`
  - `ats.pre-boarding:create,edit,delete` -> `pre-boarding.manage`
  - `ats.onboarding:create,edit,delete` -> `onboarding.manage`
  - `ats.employees:edit` -> `employees.edit` and `employees.manage`

### Anti-patterns to avoid

- Do not make `candidates.read` an umbrella alias for every new row.
- Do not rely on named roles like `Recruiter`, `Agent`, or `Administrator` for feature scope unless the route is explicitly admin-only.
- Do not remove all Candidates backstops in one PR.
- Do not migrate partial grants by expanding them to full `view,create,edit,delete`.
- Do not rename `pre-boarding` to `preboarding` in raw matrix strings. The matrix row currently derives `pre-boarding.*`.

---

## Phase 1: Add RBAC contract tests before changing behavior

### Implement

Create a focused backend permission test suite that freezes the intended alias behavior.

Suggested file:

- `src/config/__tests__/permissions.candidatesDispersion.test.js`

Cover:

- `getGrantingPermissions('candidates.read')` must not include `referralLeads.read`, `offers.read`, `pre-boarding.read`, or `interviews.manage` after each relevant migration phase.
- `getGrantingPermissions('referralLeads.read')` may temporarily include `candidates.read` only if the phase still needs legacy compatibility.
- `deriveApiPermissions(new Set(['ats.pre-boarding:view,create,edit,delete']))` produces `pre-boarding.read`, `pre-boarding.create`, `pre-boarding.edit`, `pre-boarding.delete`, and `pre-boarding.manage`.
- `deriveApiPermissions(new Set(['ats.referralLeads:view,create,edit,delete']))` produces `referralLeads.read` and `referralLeads.manage`.

Create route-level smoke tests for target-only roles. Add these phase by phase beside the existing route/service tests.

### Verification

- `npm test -- src/config/__tests__/permissions.candidatesDispersion.test.js`
- Grep check:
  - `rg "referralLeads|offers|pre-boarding|interviews" src/config/permissions.js`
  - Confirm target permissions are not hidden under `candidates.read/manage`.

---

## Phase 2: Referral leads owner migration

### Goal

ATS -> Referral leads controls `/employees/referral-leads*` and all referral-lead actions. Candidates no longer owns this surface.

### Backend route changes

In `src/routes/v1/employee.route.js`:

- Replace referral list/stats/export/link/history route gates:
  - From `requirePermissions('candidates.read')`
  - To `requireAnyOfPermissions('referralLeads.read', 'candidates.read')`

- Replace referral override/backfill/sales-agent mutation gates:
  - From `candidates.manage` or `candidates.manageSalesAgentAttribution`
  - To target referral permissions, with temporary legacy bridge:
    - `requireAnyOfPermissions('referralLeads.manage', 'candidates.manage')`

### Backend alias changes

In `src/config/permissions.js`:

- Add explicit owner aliases:
  - `referralLeads.read`: `['referralLeads.read', 'ats.referralLeads:view', 'ats.referralLeads:view,create,edit,delete']`
  - `referralLeads.manage`: `['referralLeads.manage', 'ats.referralLeads:create,edit,delete', 'ats.referralLeads:view,create,edit,delete']`
- Remove `referralLeads.read` and `ats.referralLeads:*` from `candidates.read`.
- Re-home sales attribution:
  - Add `referralLeads.manageSalesAgentAttribution` if a separate flag is still needed.
  - Prefer `referralLeads.manage` unless product needs independent attribution control.

### Service scope

In `src/services/referralLeads.service.js`:

- Change org-wide access from `candidates.manage || interviews.manage` to `referralLeads.manage || interviews.manage`.
- Keep sales agents scoped to own referrals.
- During transition, optionally allow `candidates.manage` as a route-local or service-local bridge, then remove it after DB migration.

### Frontend

In `shared/lib/permissions.ts`:

- Add:
  - `view_referral_leads`
  - `manage_referral_leads`
  - attribution-specific action only if needed

In `shared/lib/route-permissions.ts`:

- Keep `ats.candidates:` alias for `/ats/referral-leads` only until DB migration completes.
- Remove the alias in the cleanup phase.

Update referral feature code to stop using `view_candidates` / `manage_candidates`.

### DB migration

Add a migration script that copies:

- `ats.candidates:view` -> `ats.referralLeads:view`
- `ats.candidates:create|edit|delete` -> matching referral actions

Rules:

- Preserve partial grants.
- Do not add write actions if the role only had view.
- Produce dry-run output per role.
- Keep original `ats.candidates:*` until final cleanup.

### Verification

- Referral-only role can open `/ats/referral-leads`.
- Referral-only role can call list/stats/export routes.
- Referral-only manage role can perform override/backfill/attribution actions.
- Employee-only role cannot access referral-lead routes.
- Candidates-only legacy role still works during bridge period.

---

## Phase 3: Job applications owner decision and scheduler-safe route fix

### Decision

Choose one:

- Option A: add `ats.job-applications`.
  - Best if application management is separate from job management.
- Option B: fold recruiter application management into `ats.jobs`.
  - Best if job owners/admins always own applications for those jobs.

Recommended: Option A, because applications are a distinct page/API surface and interview scheduling already needs cross-job application reads.

### Backend route changes

In `src/routes/v1/jobApplication.route.js`:

- For `GET /job-applications`, accept:
  - `jobApplications.read` if Option A
  - `jobs.read` if Option B
  - `interviews.manage` for scheduler dropdown use
  - temporary `candidates.read` bridge

- For create/update/delete, accept:
  - `jobApplications.manage` or `jobs.manage`
  - temporary `candidates.manage` bridge

### Backend alias changes

If Option A:

- Add `jobApplications.read/manage` aliases for `ats.job-applications:*`.
- Add `ats.job-applications` row in frontend `roles-permissions.ts`.

### Scope

Keep `applicationScope` matrix-aware.

Current known behavior:

- `interviews.manage` bypass exists for scheduler workflows.

Add owner-key behavior:

- `jobApplications.manage` can see/manage org application rows if Option A.
- `jobs.manage` can see/manage org application rows if Option B.
- `jobApplications.read` view-only behavior must be decided: org-wide list or scoped list.

### Verification

- Interview scheduler with `ats.interviews:create|edit|delete` and no Candidates permission can list candidate applications.
- Application manager with the chosen owner row and no Candidates permission can use application CRUD routes.
- My applications remains auth-only and unaffected.

---

## Phase 4: Offers owner migration

### Backend route changes

In `src/routes/v1/offer.route.js`:

- `GET /offers`, `GET /offers/:offerId`, letter defaults:
  - `requireAnyOfPermissions('offers.read', 'candidates.read')`

- Create/update/delete/share/generate/enhance:
  - `requireAnyOfPermissions('offers.manage', 'candidates.manage')`

### Backend alias changes

In `src/config/permissions.js`:

- Keep explicit `offers.read/manage` aliases for `ats.offers:*`.
- Remove `candidates.read/manage` from `offers.read/manage` after role DB migration.

### Service scope

In `src/services/offer.service.js`:

- Add matrix-aware scope before owner filtering.
- Recommended contract:
  - `offers.read` sees org-wide offers list.
  - `offers.manage` can mutate offers.

Implementation shape:

- If `userIsAdmin(user)` or `hasApiPermission(user, 'offers.read')` then skip `createdBy` / my-jobs restriction for list.
- For update/delete/share/generate, route already requires `offers.manage`; keep record-level checks if any exist.

### Frontend

- Add `view_offers`, `manage_offers`.
- Update `/ats/offers-placement` and offer action buttons to use `ats.offers`, not candidate helpers.

### Verification

- Offers-view-only role can list org offers but cannot mutate.
- Offers-manage role can create/update/delete/share/generate.
- Role with only `ats.candidates` still works during bridge period.
- Role with only `ats.employees` cannot access offers.

---

## Phase 5: Pre-boarding owner migration

### Backend route changes

In `src/routes/v1/placement.route.js`:

- List/get:
  - `requireAnyOfPermissions('pre-boarding.read', 'candidates.read')`

- Update:
  - `requireAnyOfPermissions('pre-boarding.manage', 'candidates.manage')`

- Audit:
  - `requireAnyOfPermissions('placement.audit', 'pre-boarding.manage', 'candidates.manage')` during bridge

### Backend alias changes

In `src/config/permissions.js`:

- Add:
  - `pre-boarding.read`: raw `ats.pre-boarding:view` and full bundle.
  - `pre-boarding.manage`: raw write/full bundle.
  - `placement.audit`: include `pre-boarding.manage`.
  - `preboarding.override`: include `pre-boarding.manage`.

- After migration, remove `candidates.manage` from `placement.audit` and `preboarding.override`.

### Controller/service checks

In `src/controllers/placement.controller.js`:

- Replace direct `candidates.manage` override checks with `preboarding.override` or `pre-boarding.manage`.
- Keep `candidates.manage` only as temporary bridge if required.

### Frontend

- Add `view_preboarding`, `manage_preboarding` if semantic action checks exist.
- Verify `/ats/pre-boarding` uses only `ats.pre-boarding` after bridge cleanup.

### Verification

- Pre-boarding-only role can list/get/update placements according to granted actions.
- Offers-only role does not automatically gain pre-boarding unless product wants that coupling.
- Candidates-only legacy role still works during bridge period.

---

## Phase 6: Onboarding and employee date permissions

### Backend route changes

In `src/routes/v1/employee.route.js`:

- Joining date:
  - Transition: `onboarding.manage || employees.edit || candidates.manage`
  - Final: `onboarding.manage || employees.edit`

- Resign date:
  - Transition: `employees.edit || candidates.manage`
  - Final: `employees.edit`

### Controller helper changes

In `src/controllers/employee.controller.js`:

- `canUpdateJoiningDate(req)` final form:
  - `onboarding.manage || employees.manage || employees.edit` if `employees.edit` is available in context.
- `canUpdateResignDate(req)` final form:
  - `employees.manage || employees.edit`.

Note: `deriveApiPermissions()` emits both `employees.edit` and `employees.manage` for `ats.employees:edit`, but some existing helpers only check `employees.manage`. Be explicit in tests.

### Frontend

In `shared/lib/candidate-permissions.ts`:

- Remove `ats.candidates` from date-edit helpers only after DB migration.
- Joining date keeps `ats.onboarding` + `ats.employees`.
- Resign date keeps `ats.employees` only.

### Verification

- Onboarding manage can update joining date, not resign date.
- Employees edit can update both joining and resign date.
- Candidates legacy works only during bridge period.

---

## Phase 7: Hardcoded row-scope fixes from audit

### Recording scope

In `src/services/visibilityScope.service.js`:

- Add matrix-aware bypass after admin check and before participant-only scope.
- Do not return bare `{}` unless tenant safety is proven.
- Preferred safe form:
  - derive the same tenant meeting set admin uses, but without orphan rows unless product approves.
  - allow `meetings.manage` or `interviews.manage` to see tenant meeting recordings.

Also decide route access:

- `GET /recordings` currently requires `meetings.record`.
- If Communication -> Meetings C/E/D should control recordings, alias `meetings.record` from `meetings.manage`.
- If ATS Interviews should control interview recordings, explicitly alias or route-bridge from `interviews.manage`.

### Offers scope

Covered in Phase 4.

### Analytics scope

In `src/services/atsAnalytics.service.js`:

- Replace `userHasRecruiterRole` scoping with permission-aware scope.
- Recommended contract:
  - `ats.analytics:view` sees analytics permitted by the rows also granted.
  - `jobs.read/manage` controls job totals.
  - `referralLeads.read/manage` or `employees.read/manage` controls people/candidate totals.
  - `jobApplications.read/manage` or selected owner controls application totals.

If product wants Analytics View to mean org-wide ATS analytics, document it and implement a single `analytics.read` bypass.

### Dead code cleanup

Remove only after verifying no production imports:

- `candidateScope`
- `jobScope`

Update `src/services/__tests__/visibilityScope.service.test.js`.

### Verification

- Recordings route + scope tests for:
  - own participant
  - meetings manager
  - interviews manager
  - unrelated user
  - tenant isolation

- Analytics tests for:
  - recruiter named role without matrix
  - matrix analytics role without Recruiter name
  - jobs-only analytics
  - candidates/referrals-only analytics, if partial visibility is implemented

---

## Phase 8: Settings and cross-cutting aliases

### Remove Candidates from these aliases

In `src/config/permissions.js`, after role DB migration:

- `company-email.read/manage`
- `candidate-sop.read/manage`
- `share-candidate-form.read`
- `positions.read/manage`
- `uploads.document`
- `employees.create/edit/delete`
- `placement.audit`
- `preboarding.override`

### Replace with owner rows

- Company email -> `settings.company-email`
- Employee SOP -> `settings.candidate-sop`
- Share candidate form -> `ats.share-candidate-form`
- Positions -> `training.positions`
- Uploads -> feature-specific `*.manage`
- Employees CRUD -> `ats.employees`

### PM assistant and teams media

- `pmAssistant.route.js` / service checks:
  - replace `candidates.read` with the specific data owner:
    - `employees.read` if reading employee directory
    - `teams.read` if reading project teams

- `team.controller.js` / `team.service.js` candidate photo checks:
  - replace `candidates.read` with `employees.read` or `teams.read` depending on feature surface.

### Notification audit

- Decide owner:
  - admin-only operational route
  - or a settings/logs permission, e.g. `logs.activity` or `settings.notifications`

Keep hardcoded admin/superadmin only if this is truly not a regular matrix feature.

---

## Phase 9: Frontend cleanup

### Route aliases

In `shared/lib/route-permissions.ts`:

- Remove `ats.candidates:` from `EMPLOYEES_PATH_PREFIXES` after employee migration.
- Remove `ats.candidates:` alias for `ats.referralLeads:`.
- Keep `/ats/candidates` only as a redirect/legacy path guard if needed, not as an access grant to new pages.

### Semantic actions

In `shared/lib/permissions.ts`:

Add and use dedicated actions:

- `view_referral_leads`, `manage_referral_leads`
- `view_offers`, `manage_offers`
- `view_preboarding`, `manage_preboarding`
- `view_onboarding`, `manage_onboarding`
- `view_job_applications`, `manage_job_applications` if Option A
- `view_analytics`, `export_analytics`
- settings-specific actions only if components need them

Then grep and replace:

- `view_candidates`
- `manage_candidates`
- `ats.candidates`
- `candidates.read`
- `candidates.manage`

Do not remove candidate wording from domain data models unless this phase explicitly includes copy/model cleanup.

### Verification

- Role with only target row sees target nav/page.
- Role with target view only does not see write buttons.
- Role with write action sees expected buttons.
- Role with only Candidates no longer opens dispersed pages after final cleanup.

---

## Phase 10: DB migration and rollout

### Build migration script

Suggested file:

- `scripts/migrations/2026-05-28-rbac-disperse-candidates.js`

Capabilities:

- `--dry-run`
- `--apply`
- `--phase referral|offers|preboarding|onboarding|jobApplications|all`
- idempotent role updates
- per-role before/after output
- unknown/unmapped permission report
- no destructive removal until final cleanup flag

### Copy rules

For each role:

- `ats.candidates:view` -> target `:view`
- `ats.candidates:create` -> target `:create`
- `ats.candidates:edit` -> target `:edit`
- `ats.candidates:delete` -> target `:delete`
- full bundle -> full target bundle
- partial grant -> same partial target grant

Never auto-expand partial grants.

### Rollout order

1. Deploy route-local bridges and target frontend actions.
2. Run dry-run migration on UAT.
3. Review partial grants and unknown strings.
4. Apply migration on UAT.
5. QA target-only roles.
6. Apply migration on production.
7. Remove legacy route bridges per feature.
8. Remove Candidates matrix row or mark deprecated.

### Rollback

- Migration must write a JSON audit file with original role permissions.
- Rollback script restores original role permissions by role `_id`.
- Runtime rollback is safe while route-local legacy bridges remain.
- After legacy bridge removal, rollback requires redeploying aliases/routes or reapplying target permissions.

---

## Final acceptance criteria

- No non-admin route outside the employee legacy surface requires only `candidates.read` or only `candidates.manage`.
- `src/config/permissions.js` no longer uses `candidates.read/manage` as an umbrella alias for unrelated matrix rows.
- A role with only `ats.referralLeads:*` can use referral leads and nothing else from Candidates.
- A role with only `ats.offers:*` can use offers and nothing else from Candidates.
- A role with only `ats.pre-boarding:*` can use pre-boarding and nothing else from Candidates.
- A role with only `ats.onboarding:*` can use onboarding actions and not employee resign-date unless also granted Employees.
- Job applications are controlled by the chosen owner row and scheduler routes still work for interview managers.
- Frontend nav, route guards, and buttons use the same target rows as backend routes.
- Admin/superadmin exceptions are documented and limited to true admin/superadmin surfaces.

---

## Suggested PR breakdown

1. PR1: Permission contract tests + referral leads migration.
2. PR2: Job applications owner decision + scheduler-safe route fix.
3. PR3: Offers route/scope/frontend migration.
4. PR4: Pre-boarding route/scope/frontend migration.
5. PR5: Onboarding/date permission cleanup.
6. PR6: Recording/analytics hardcoded scope fixes.
7. PR7: Settings/cross-cutting alias cleanup.
8. PR8: DB migration runbook + final Candidates deprecation.

Keep each PR small enough to QA with one target-only role and one legacy role.
