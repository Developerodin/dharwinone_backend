# RBAC Hardcoded Row-Scope Audit

**Date:** 2026-05-28  
**Repos:** `uat.dharwin.backend`, `uat.dharwin.frontend`  
**Purpose:** Handoff for Codex / engineering review — map hardcoded role gates that bypass the permission matrix for **data visibility** (which DB rows a user sees), trace to routes and frontend pages, and recommend matrix checkbox wiring.

---

## Executive summary

| Metric | Count |
|--------|------:|
| Role-helper mentions in backend `src/` (`userIsAdmin`, `userHasRecruiterRole`, `userIsSalesAgent`, `userIsAgent`, `userIsAdminOrAgent`) | ~161 |
| **Same anti-pattern as the interview scheduler bug** (row list scoped by role name, matrix grant ignored) | **3 live** |
| **Fixed** (shipped) | **1** (`applicationScope`) |
| **Dead code** (exported scope fns, zero callers) | **2** (`candidateScope`, `jobScope`) |
| **Already matrix-aware** (no scope fix needed) | 4 areas (see §5) |

The initial grep of **~129–161 hits across 34+ files** is **not** 161 separate bugs. Most hits are intentional admin gates, owner checks, dashboard routing, or HR approval flows.

**User-visible ATS scheduler workflow today:**

| Surface | Status |
|---------|--------|
| Schedule Interview → job/position dropdown (`GET /job-applications`) | **Fixed** via `interviews.manage` bypass |
| Interview candidate picker (`GET /employees/referral-leads`) | **OK** — matrix-aware |
| Jobs dropdown (`GET /jobs`) | **OK** — `jobs.read` / `jobs.manage` |
| Recordings library (`GET /recordings`) | **Gap** — route + row scope |
| Offers list (`GET /offers`) | **Gap** — role-based row filter |
| ATS Analytics totals | **Partial** — applications scoped; jobs/candidates use named Recruiter role |

---

## Background: the bug we fixed

**Symptom:** User with ATS Interviews Create+Edit+Delete (e.g. Sami) could pick a candidate in Schedule Interview but job dropdown showed *"No job applications for this candidate"*.

**Root cause:** `applicationScope` in `src/services/visibilityScope.service.js` filtered job applications by recruiter ownership / candidate ownership. Matrix-granted interview schedulers were treated as plain users.

**Fix (shipped):** After admin check, if `hasApiPermission(actor, 'interviews.manage')` → return `{ filter: {} }`.

**Matrix wiring:**

```
Settings → Roles → ATS → Interviews → [Create | Edit | Delete]
  → stored as ats.interviews:create,edit,delete (or subset)
  → permission.service.js deriveApiPermissions → interviews.manage
  → applicationScope bypass
```

**Call chain:**

```
GET /v1/job-applications (candidates.read)
  → jobApplication.controller.list
  → jobApplication.service.queryJobApplications
  → applicantQuery.service.buildApplicantQuery
  → visibilityScope.applicationScope
```

**Frontend:**

- `app/(components)/(contentlayout)/ats/interviews/_components/CreateInterviewModal.tsx` — `listJobApplications({ candidateId })`
- `InterviewsClient.tsx` — dynamic `listJobApplications`
- Also: `ats/applications/page.tsx`, `ats/jobs/page.tsx`, `dashboard/page.tsx`, `offers-placement/CreateOfferForm.tsx`, onboarding edit client

---

## How permission matrix maps to API keys

From `src/services/permission.service.js` (`deriveApiPermissions`):

| Matrix checkbox | Stored permission fragment | Derived API key |
|-----------------|----------------------------|-----------------|
| **View** | `:view` | `{resource}.read` |
| **Any of Create / Edit / Delete** | `:create`, `:edit`, `:delete` | `{resource}.manage` |

Resource name = segment after first dot (e.g. `ats.interviews` → `interviews`).

**Frontend matrix definitions:** `uat.dharwin.frontend/shared/lib/roles-permissions.ts`  
**Route → permission mapping:** `uat.dharwin.frontend/shared/lib/route-permissions.ts`  
**Matrix UI:** `settings/roles/add`, `settings/roles/edit`

**Alias expansion:** `src/config/permissions.js` (`permissionAliases`) — e.g. `interviews.read` can satisfy route gates that require `candidates.read` for picklists.

---

## Matrix rows relevant to ATS (confirmed in permissions.js)

| Matrix row (UI) | View → | Create/Edit/Delete → | Notes |
|-----------------|--------|----------------------|-------|
| ATS → Candidates | `candidates.read` | `candidates.manage` | Full employee/candidate list when manage |
| ATS → Referral leads | (via `candidates.read` aliases) | (via `candidates.manage`) | Org-wide list also if `interviews.manage` |
| ATS → Interviews | `interviews.read` | `interviews.manage` | **Used for applicationScope bypass** |
| ATS → Jobs | `jobs.read` | `jobs.manage` | Full jobs listing |
| ATS → Offers | `offers.read` | `offers.manage` | Route gate only; **not** used in `queryOffers` filter |
| ATS → Analytics | `ats.analytics:view` | `ats.analytics:view,export` | Route `ats.analytics`; internal counts still role-forked |
| Communication → Internal Meetings | `meetings.read` | `meetings.manage` | **≠** `meetings.record` |
| *(no matrix row)* | — | — | `meetings.record` — aliases: `mentors.manage`, `training.manage` |

---

## Findings: live scope leaks (fix candidates)

### 1. recordingScope — HIGH priority for ops / interview managers

| Field | Value |
|-------|-------|
| **Function** | `recordingScope` @ `src/services/visibilityScope.service.js:184` |
| **Role pattern** | Admin → tenant meetings + orphan rows; non-admin → only recordings for meetings where user is host/participant/invite (**no matrix bypass**) |
| **Route gate** | `GET /v1/recordings` requires **`meetings.record`** (`recording.route.js:18`) — separate from `meetings.manage` |
| **Data scope** | `recording.service.js:158` → `recordingScope` |
| **Frontend** | `communication/recordings/page.tsx` — `listAllRecordings()`; `RecordingsModal.tsx` on interviews/meetings (per-meeting path) |
| **Recommended bypass** | After admin check: `meetings.manage` **OR** `interviews.manage` → `{ filter: {} }` |
| **Matrix checkboxes** | Communication → Meetings → C/E/D **and/or** ATS → Interviews → C/E/D |
| **Severity** | **MED** — users may pass route gate but see empty/partial list |

**Note:** Fixing data scope does not grant API access; role still needs `meetings.record` (or alias) to hit the endpoint.

---

### 2. queryOffers — HIGH for offer coordinators

| Field | Value |
|-------|-------|
| **Function** | `queryOffers` @ `src/services/offer.service.js:770` |
| **Role pattern** | Admin → all offers; non-admin → offers for jobs **they created** OR offers **they created** — **ignores `offers.manage`** |
| **Route** | `GET /v1/offers` — `candidates.read` (`offer.route.js:52`) |
| **Frontend** | `ats/offers-placement/page.tsx` — `listOffers` |
| **Recommended bypass** | `hasApiPermission(user, 'offers.manage')` → skip `createdBy` / my-jobs filter |
| **Matrix checkbox** | ATS → Offers → Create/Edit/Delete → `offers.manage` |
| **Severity** | **HIGH** for matrix-granted offer managers who are not named Administrator |

---

### 3. getAtsAnalytics / getDrillDown — MED (dashboard numbers)

| Field | Value |
|-------|-------|
| **Functions** | `getAtsAnalytics` @ `atsAnalytics.service.js:62`; `getDrillDown` @ `:251` |
| **Role pattern** | `userHasRecruiterRole` narrows **candidate** counts (`assignedRecruiter`) and **job** counts (`createdBy`); **application** metrics use `buildApplicantQuery` (inherits `applicationScope` fix) |
| **Routes** | `GET /v1/ats/analytics`, `/drill`, `/applications-over-time-by-candidates` — require `ats.analytics` |
| **Frontend** | `ats/analytics/page.tsx`, `dashboard/page.tsx` (`getAtsAnalytics`) |
| **Recommended fix** | Replace recruiter role fork with matrix keys (`jobs.manage`, `candidates.manage`) or treat `ats.analytics` view as org-wide for totals |
| **Matrix checkbox** | ATS → Analytics → View (and export if needed) |
| **Severity** | **MED** — charts partially correct, headline totals wrong for non-Recruiter matrix grantees |

---

## Findings: visibilityScope module (full picture)

| Function | Lines | Production callers | Status |
|----------|------:|-------------------|--------|
| `applicationScope` | ~106 | `applicantQuery.service.js` | **Fixed** — `interviews.manage` bypass |
| `recordingScope` | ~184 | `recording.service.js` | **Live gap** — see §1 |
| `candidateScope` | ~42 | **None** (tests only) | **Dead code** — delete |
| `jobScope` | ~69 | **None** (tests only) | **Dead code** — delete |

Candidates list does **not** use `candidateScope`. It uses `employee.controller.js` + `queryCandidates` with `candidates.manage` gate.

Jobs list does **not** use `jobScope`. It uses `job.service.queryJobs` + `userCanViewAllJobsForListing`.

---

## Already matrix-aware (no row-scope fix needed)

### Referral leads

- **Fn:** `canSeeAllReferralLeads` / `canUserSeeAllReferralLeads` @ `referralLeads.service.js:267`
- **Logic:** Org-wide if `candidates.manage` OR `interviews.manage`; sales agents always own referrals only
- **Route:** `GET /v1/employees/referral-leads`
- **Frontend:** `InterviewsClient.tsx`, `ats/referral-leads/page.tsx`, `SalesAgentDashboard.tsx`

### Jobs listing

- **Fn:** `userCanViewAllJobsForListing` @ `roleHelpers.js:181`
- **Logic:** `jobs.read` OR `jobs.manage` from matrix (+ legacy named-role fallback)
- **Route:** `GET /v1/jobs`
- **Frontend:** `ats/jobs/page.tsx`, `InterviewsClient.tsx`

### Candidates / employees list

- **Fn:** `canManageCandidates` → `candidates.manage` @ `employee.controller.js:82`
- **Logic:** Managers see all; view-only scoped to own profile / agent assignment
- **Route:** `GET /v1/employees`
- **Frontend:** `ats/employees/`, dashboard widgets

### Job applications (post-fix)

- **Fn:** `applicationScope` with `interviews.manage` bypass
- **Route:** `GET /v1/job-applications`

---

## Intentional role checks (NOT scope leaks — do not “fix” blindly)

| Area | Files | Why OK |
|------|-------|--------|
| Auth / admin middleware | `requireAdministratorRole.js`, `requireRoleByName.js`, `auth.controller.js` | Endpoint 403 gates |
| Placement access | `placement.service.js`, `placementAccess.util.js` | Single-resource 403 (admin/agent) |
| Recruiter notes | `recruiterNote.service.js` | Note visibility (public vs own), not pipeline rows |
| PM tasks | `task.service.js` `canManageTask` | Uses `tasks.manage` after admin/owner |
| HR approvals | `leaveRequest.service.js`, `backdatedAttendanceRequest.service.js` | Manager workflow |
| Dashboard routing | `pageCapabilities.service.js` | Widget/endpoint hints by role name — UX, not DB filter |
| Meeting access | `meetingAccess.service.js` | Per-meeting participant auth |
| AI assistants | `chatAssistant.service.js`, `pmAssistant.service.js` | Feature entry gates |

---

## Recommended fix order (for implementer)

1. **`recordingScope`** — add OR-bypass for `meetings.manage` \| `interviews.manage` (~10 lines). No new matrix rows.
2. **`queryOffers`** — add `offers.manage` bypass (mirror `applicationScope` pattern).
3. **`getAtsAnalytics` / `getDrillDown`** — replace `userHasRecruiterRole` forks with matrix-aware scope.
4. **Cleanup** — remove `candidateScope`, `jobScope` exports and trim `__tests__/visibilityScope.service.test.js`.
5. **Docs** — add matrix help text: which toggles unlock org-wide read for each ATS surface.

---

## Test plan (after fixes)

### applicationScope (already shipped)

1. Log in as user with Interviews C/E/D, without Recruiter/Administrator role name.
2. ATS → Interviews → Schedule Interview → pick candidate with applications owned by another recruiter.
3. Job dropdown must list applied jobs (not empty).
4. Submit interview; verify job link persisted.

### recordingScope (when fixed)

1. Same user + grant `meetings.record` (or mentor/training alias if used).
2. Open Communication → Recordings — expect org-wide list if Meetings C/E/D or Interviews C/E/D checked.
3. Without bypass perm, still only own-meeting recordings.

### queryOffers (when fixed)

1. User with Offers C/E/D, not admin, did not create target jobs.
2. ATS → Offers & Placement — must see offers for org jobs.

### atsAnalytics (when fixed)

1. User with Analytics View + Jobs/Candidates manage, without Recruiter role name.
2. ATS Analytics + dashboard totals must match org-wide counts, not recruiter-scoped subset.

---

## Codex review checklist

- [ ] Confirm `applicationScope` bypass cannot leak cross-tenant (admin + `interviews.manage` only within tenant context).
- [ ] Validate proposed `recordingScope` bypass against multi-tenant `tenantId` / `adminId` rules.
- [ ] Confirm `offers.manage` bypass in `queryOffers` aligns with route permission `candidates.read` vs `offers.read`.
- [ ] Assess whether `interviews.read` (view-only) should also bypass scopes (currently **no** for applications).
- [ ] Verify dead code removal of `candidateScope` / `jobScope` has no dynamic imports.
- [ ] Check `pageCapabilities.service.js` for UX drift when matrix grants ATS access but dashboardType stays recruiter/salesAgent.
- [ ] Ensure frontend matrix rows in `roles-permissions.ts` match backend alias keys in `permissions.js`.

---

## Key file index

| File | Role |
|------|------|
| `src/services/visibilityScope.service.js` | Central scope builders |
| `src/services/applicantQuery.service.js` | Calls `applicationScope` |
| `src/services/recording.service.js` | Calls `recordingScope` |
| `src/services/offer.service.js` | `queryOffers` role filter |
| `src/services/atsAnalytics.service.js` | Recruiter fork on aggregates |
| `src/services/referralLeads.service.js` | Matrix-aware referral scope |
| `src/services/job.service.js` | Matrix-aware jobs query |
| `src/controllers/employee.controller.js` | Matrix-aware candidates list |
| `src/utils/roleHelpers.js` | Role helpers + `userCanViewAllJobsForListing` |
| `src/utils/permissionCheck.js` | `hasApiPermission` |
| `src/services/permission.service.js` | `deriveApiPermissions` |
| `src/config/permissions.js` | Alias map |
| `src/routes/v1/jobApplication.route.js` | Job applications API |
| `src/routes/v1/recording.route.js` | Recordings API |
| `src/routes/v1/offer.route.js` | Offers API |
| `src/routes/v1/atsAnalytics.route.js` | Analytics API |
| `uat.dharwin.frontend/shared/lib/roles-permissions.ts` | Matrix UI definitions |
| `uat.dharwin.frontend/shared/lib/route-permissions.ts` | Frontend route gates |

---

## Revision history

| Date | Author | Notes |
|------|--------|-------|
| 2026-05-28 | Cursor audit session | Initial document from backend + frontend trace; no code changes in audit pass |
