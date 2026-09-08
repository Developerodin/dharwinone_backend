<style>
table { display: block; width: max-content; max-width: 100%; overflow-x: auto; }
</style>

# ATS PRD / Product / Git Evolution Audit

**Audit date:** 7 September 2026  
**PRD source:** Dharwin Business Integrated ATS_Updated.pdf (22 pages, 4 modules)  
**Repositories:** uat.dharwin.backend, uat.dharwin.frontend  
**Method:** Read-only forensic audit. PRD parse, route inventory, code trace, Git history. No code changes.  
**Primary unit of analysis:** PAGE (module → page → screens → functionality).

---

## 1. Executive Summary

| Metric | Value |
|--------|------:|
| PRD modules | 4 |
| PRD requirements | **155** |
| Current nav modules | **7** (+ Dashboard, Settings, public portals) |
| ATS authenticated routes | **22** |
| Public / candidate routes | **6** |
| Pages not in original PRD | **18+** |
| Strict PRD coverage (all modules) | **32.9%** (51/155) |
| Weighted PRD coverage | **59.6%** (🟢=1.0, 🟡=0.5, ⚠️/🟣=0.75, 🔴=0) |
| ATS module strict | **31.7%** (19/60) |
| Extra features beyond PRD | **~69** (3 prior “extras” reclassified as original PRD — see §CORRECTION False extras) |

**ID catalog:** §6C is canonical; §6 page audits reference it only.

**Evolution:** PRD lists Express as an allowed framework (p.19); shipped **Express/MongoDB/Next.js**. Real divergences: Prisma, PostgreSQL, tRPC, Auth.js, Casbin. PRD also lists compliance binders, e-signatures, calendar sync, and broad AI. Shipped product is **Express/MongoDB/Next.js** with a **richer ATS** (external jobs, referral CRM, candidate self-service, HRMS on employees page) from a March 2026 UI wave (`04759f8a`), then telephony, auto-fetch, pagination, and lifecycle splits through September 2026. **Client-request Git evidence is sparse** (one confirmed Plivo migration); most changes are internal.

---

## 2. Original PRD Structure

### Module 1 — ATS (60 requirements)

| PRD Area | IDs | Count |
|----------|-----|------:|
| Job Posting | ATS-JOB-001–005 | 5 |
| Candidate & Compliance | ATS-CAND-001–010 | 10 |
| Recruiter | ATS-REC-001–006 | 6 |
| Application Workflow | ATS-APP-001–005 | 5 |
| Interview | ATS-INT-001–009 | 9 |
| Offer & Placement | ATS-OFF-001–005 | 5 |
| Pre-boarding & Onboarding | ATS-PRE-001–009 | 9 |
| Analytics | ATS-ANA-001–004 | 4 |
| AI Integration | ATS-AI-001–007 | 7 |


### PRD headline bullets vs audit IDs (148 → 155)

The PDF uses **148 numbered headline bullets** across four modules. The audit uses **155 requirement IDs** because compound bullets are split where the merged matrix tracks distinct deliverables.

| Module / area | PDF headline bullets | Audit IDs | Δ | Decomposition rule |
|---------------|---------------------:|----------:|--:|-------------------|
| ATS — Job Posting | 5 | 5 | 0 | 1:1 |
| ATS — Candidate & Compliance | 9 | 10 | +1 | Bullet 9 split → `CAND-009` material change log + `CAND-010` version history |
| ATS — Recruiter | 6 | 6 | 0 | 1:1 |
| ATS — Application Workflow | 5 | 5 | 0 | 1:1 |
| ATS — Interview | 9 | 9 | 0 | 1:1 |
| ATS — Offer & Placement | 4 | 5 | +1 | Placement compliance auto-update → `OFF-005` |
| ATS — Pre-boarding & Onboarding | 5 | 9 | +4 | Five headline bullets → nine checklist items (`PRE-001`…`009`, §7.1–7.9) |
| ATS — Analytics | 4 | 4 | 0 | 1:1 |
| ATS — AI | 7 | 7 | 0 | 1:1 |
| **ATS subtotal** | **54** | **60** | **+6** | |
| Communication | 35 | 38 | +3 | Security / AI sub-bullets expanded in matrix |
| Training | 31 | 29 | −2 | Two PRD bullets merged in matrix (see merged audit §2) |
| Projects | 28 | 28 | 0 | 1:1 |
| **Grand total** | **148** | **155** | **+7** | |

### Modules 2–4

- **Communication (38):** Email, chat, voice/video, files, dashboards, security, AI, ATS links.
- **Training (29):** Curriculum, attendance, mentors, dashboards, evaluation, analytics, AI.
- **Projects (28):** Setup, kanban, deliverables, dashboards, collaboration, AI.

**PRD stack — actual vs specified:**

| PRD item | Shipped | Notes |
|----------|---------|-------|
| Express | ✅ Express ESM | PRD p.19 allows Express + tRPC |
| NestJS / tRPC | — | Not used |
| MongoDB vs PostgreSQL | MongoDB | Divergence |
| Prisma | — | Mongoose instead |
| Auth.js | — | JWT + Passport |
| Casbin | — | Mongo Role RBAC |
| Meilisearch / pgvector | — | Pinecone/Qdrant for embeddings; pg_trgm was PRD starter search |
| BullMQ | Partial | Used for summaries |

---

## 3. Actual Current Product Structure

```
Dashboard (/dashboard)
ATS (/ats/*, /courses, public routes)
Organization (/organization/*)     [NOT IN PRD]
Communication (/communication/*)
Training (/training/*, /courses)
Projects (/apps/projects/*, /task/*, /project-management/*)
Logs (/logs/*)
Settings (/settings/*)
Help (/help-and-support)
Public: /public-job, /public-recruiter, /public-employee, /candidate-onboard, /join/room
```

**Naming:** PRD "Candidate" → UI **Employees** (`/ats/employees`).

---

## 4. Complete Module Inventory

| Module | In PRD? | Pages | Evidence |
|--------|---------|------:|----------|
| ATS | Yes | 22+ | nav.tsx, app/.../ats/ |
| Organization | No | 5 | nav.tsx ORGANIZATION |
| Communication | Yes | 7 | nav.tsx Communication |
| Training | Yes | 8+ | nav.tsx Training |
| Projects | Yes | 6+ | nav.tsx PM |
| Logs | Partial | 2 | activityLog |
| Dashboard | Partial | 1 | role widgets |
| Settings | Partial | 10+ | /settings/* |
| Help | No | 1 | iframe |

---

## 5. Complete Page Inventory

| Module | Page | Route | Exists | PRD? | New? | First Git (FE) |
|--------|------|-------|--------|------|------|----------------|
| ATS | Jobs | /ats/jobs | Yes | Yes | No | 04759f8a |
| ATS | Applications | /ats/applications | Yes | Yes | No | fec06a70 |
| ATS | External Jobs | /ats/external-jobs | Yes | No | **Yes** | 26dc20c / 94ffd8be |
| ATS | Employees | /ats/employees | Yes | Yes | Renamed | 04759f8a |
| ATS | Referral Leads | /ats/referral-leads | Yes | No | **Yes** | aa6dc41 / 7efc49d2 |
| ATS | Share Candidate Form | /ats/share-candidate-form | Yes | No | **Yes** | 7cbf2fda |
| ATS | Browse Jobs / My Apps / My Profile | /ats/browse-jobs etc. | Yes | Partial | **Yes** | 94ffd8be |
| ATS | Recruiters | /ats/recruiters | Yes | Yes | No | 04759f8a |
| ATS | Interviews | /ats/interviews | Yes | Yes | No | 04759f8a |
| ATS | Offers & Placement | /ats/offers-placement | Yes | Yes | No | 04759f8a |
| ATS | Pre-boarding / Onboarding | /ats/pre-boarding, /onboarding | Yes | Yes | Split | d0697fd3 split |
| ATS | Analytics | /ats/analytics | Yes | Yes | No | 04759f8a |
| ATS | Job Applications (removed) | /ats/job-applications | **No** | Yes | Merged | da120383 |
| Org | Org Chart | /organization/chart | Yes | No | **Yes** | 2a6478f2 |
| Org | Structure | /organization/structure | Yes | No | **Yes** | 2a6478f2 |
| Org | Departments | /organization/departments | Yes | No | **Yes** | 2a6478f2 |
| Org | Directory | /organization/directory | Yes | No | **Yes** | 2a6478f2 |
| Org | Scenarios | /organization/scenarios | Yes | No | **Yes** | 2a6478f2 |
| Comm | Email, Chats, Meetings, Dialer, Calling, Recordings, Files | /communication/* | Yes | Yes | Partial | Feb–Jul 2026 |
| Training | Curriculum, Attendance, Mentors, Students, Eval, Analytics | /training/* | Yes | Yes | No | Feb 2026 |
| PM | Projects, Tasks, Kanban, Teams, Analytics | various | Yes | Yes | No | Jun 2026 |

---

## 6. Module-by-Module Audit

### MODULE: ATS

### Jobs (List, Create, Edit)
**Route:** `/ats/jobs, /ats/jobs/create, /ats/jobs/edit/[id]`  |  **Module:** ATS

#### A. PRD Requirements for This Page

*IDs from §6C catalog only.*

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-JOB-001 | Jobs with org, skill tags, description, job type, location |
| ATS-JOB-002 | Excel import/export |
| ATS-JOB-003 | Full CRUD |
| ATS-JOB-004 | Search and sort |
| ATS-JOB-005 | Job description templates |

#### B. What We Built

**Screens:** Jobs list (`JobsClient.tsx`), Create, Edit. **APIs:** `/v1/jobs`, import/export, job-templates.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-JOB-001 Job fields | Full form: skills, salary, experience, type, location, department | 🟢 | job.model.js, JobsClient |
| ATS-JOB-002 Excel import/export | Import, export, template endpoints | 🟢 | job import/export routes |
| ATS-JOB-003 Full CRUD | Create, read, update, delete | 🟢 | job.route.js |
| ATS-JOB-004 Search and sort | Multi-filter + server pagination | 🟢 | job.service.js |
| ATS-JOB-005 JD templates | Settings job-templates + apply on create | 🟢 | jobTemplate.model.js |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| Bolna AI job verification call | Job row action | Automated phone verification of job details | No | bolna routes, JobsClient |
| Bookmarks | Jobs list | Save jobs for quick access | No | bookmark API |
| Referral share links | Job actions | Generate referral URLs | No | referral routes |
| Apply candidate from job | Job list modal | Create application without leaving jobs | No | JobsClient apply modal |

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-03-06 | 04759f8a | Core jobs UI wave | 🔵 Internal |
| 2026-09 | 9fd031de, 757dd42a | Server-side pagination | 🔵 Internal scale |
| 2026-02–04 | 94ffd8be+ | External jobs split from jobs | 🔵 Internal product expansion |

**Removed:** Standalone `/ats/job-applications` merged into `/ats/applications` (da120383).

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 5 |
| Fully implemented | 5 |
| Partial | 0 |
| Missing | 0 |
| Extra features | 5+ |

---
### Applications
**Route:** `/ats/applications`  |  **Module:** ATS

#### A. PRD Requirements for This Page

*IDs from §6C catalog only. ATS-AI-002 scored on Applications page because Bolna fires on apply; see §CORRECTION Bolna.*

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-APP-001 | Pipeline stages |
| ATS-APP-002 | Notes, feedback, status |
| ATS-APP-003 | Automated notifications to candidates |
| ATS-APP-004 | Audit trail of pipeline movements |
| ATS-APP-005 | Bulk-move stages |
| ATS-AI-002 | Call, verify, auto-schedule (cross-cutting) |

#### B. What We Built

**Screens:** Applications table (`ApplicationsClient.tsx`), detail drawer/modal, stage change actions.

**User can:** List applications with filters; change status one-at-a-time (7 statuses); view candidate/job context; export; Bolna candidate verification calls.

**Stage moves (ATS-APP-005):** **Single-application** status change is supported — `PATCH /v1/job-applications/:applicationId` (`updateStatus`, `atsPipeline.js` transition guards). **Create Offer** auto-moves application to **Offered** (`offer.service.js`); placement queues on Offers & Placement advance lifecycle. **Not built:** multi-select bulk API (no batch route).

**Audit trail (ATS-APP-004):** `activityLogService.createActivityLog` on create, status change, withdraw, and delete (`jobApplication.controller.js` lines 50, 163, 178, 192). No dedicated per-application audit UI.

**APIs:** `/v1/job-applications`, export, `/v1/bolna/*`.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-APP-001 Pipeline | 7 statuses incl. Shortlisted, Rejected | 🟣 | atsPipeline.js |
| ATS-APP-002 Notes/feedback/status | Status per row; notes on candidate | 🟡 | ApplicationsClient.tsx |
| ATS-APP-003 Automated notifications | Email on status change | 🟢 | jobApplication.service.js notifyByEmail |
| ATS-APP-004 Audit trail | activityLog on create/status/withdraw/delete | 🟡 | jobApplication.controller.js:50,163,178,192 |
| ATS-APP-005 Bulk-move stages | **Single** PATCH per row + Create Offer → Offered + placement queues; **no** multi-select batch | 🟡 | `PATCH /job-applications/:id`, offer.service.js |
| ATS-AI-002 AI verify + schedule | Bolna calls + stored logs; no auto-schedule | 🟡 | bolnaCandidateVerification.service.js |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| Shortlisted status | Pipeline | Extra stage between Screening and Interview | No | atsPipeline.js |
| Rejected + reopen | Pipeline | Reject and reopen applications | No | atsPipeline.js |
| Merged from job-applications page | Route | Single applications hub | No | da120383 |

#### E. Git History & Evolution

| 2026-05-14 | fec06a70 | Applications page added | 🔵 Internal |
| 2026-02-23 | da120383 | Deleted /ats/job-applications | 🔵 Internal merge |
| 2026-09 | 9fd031de | Server pagination | 🔵 Internal |

#### Page Scorecard

| PRD reqs | 6 (5 APP + AI-002 on page) | Full | 1 | Partial | 4 | Missing | 0 | Different | 1 | Extra | 3 |

---
### NEW PAGE — External Jobs (Full Audit)

**Route:** `/ats/external-jobs` (`?tab=search|saved|contacts`)  
**Module:** ATS — **not in PRD** (product expansion: external job aggregation + Apollo HR outreach)  
**First Git:** `26dc20c` (2026-02-26, backend RapidAPI integration); FE wave `94ffd8be` / `04759f8a`  
**Client evidence:** ⚪ Unknown (internal product expansion)

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement |
|----------------|-----------------|
| — | **None.** PRD Job Posting covers internal jobs only. External aggregation is entirely post-PRD scope. |

#### B. What We Built

**Primary files:** `ats/external-jobs/page.tsx` (~2,100 lines), `ExternalJobPreviewPanel.tsx`, `AutoFetchModal.tsx`, `shared/lib/api/external-jobs.ts`, `external-jobs-autofetch.ts`, `external-jobs-errors.ts`

**Tabs (URL-driven via `?tab=`):**

| Tab | User can | Backend |
|-----|----------|---------|
| **Search** | Query title + location; pick provider (`active-jobs-db`, `linkedin-job-search-api`, `linkedin-jobs-api`); filter date posted (mapped per-source to RapidAPI windows); work arrangement (remote_ok / remote_solely / remote_both); infinite-scroll style paging with offset; open preview panel; save/unsave bookmark; copy external apply URL (`platformUrl`); share link | `POST /v1/external-jobs/search` |
| **Saved** | Paginated list of saved external jobs; search `q`; filter by source; filter saved date range (`savedFrom`/`savedTo` YMD); unsave; open preview | `GET /v1/external-jobs/saved`, `GET /saved/ids`, `DELETE /saved/:externalId` |
| **Contacts** | Card grid of saved Apollo HR contacts; search; saved-date filter; pagination (page size divisible by 2 and 3 for grid); delete contact | `GET /v1/external-jobs/hr-contacts`, `GET /hr-contacts/ids`, `DELETE /hr-contacts/:apolloId` |

**Preview panel actions:** View full description/salary/location metadata; **Find HR contacts** (Apollo enrich for company); save individual contacts; open external apply link.

**Auto-fetch (admin):** Modal configures recurring sync (`AutoFetchModal`); status badge on page header. Manage-only APIs: `GET/POST/PATCH /auto-fetch`, `POST /auto-fetch/run`, `GET /auto-fetch/runs`. Scheduler (`externalJobAutoFetch.scheduler.js`) runs configured title/location queries and can publish mirrors into internal `Job` (`publishedJobId` on `ExternalJob` model).

**Data persisted:** `ExternalJob` Mongo collection — unique index `(externalId, source, savedBy)`; fields include `locationMeta` (city/state/country), salary range, `postedAt`, `platformUrl`, optional `publishedJobId` link to internal job.

**Integrations:**

| Integration | Role |
|-------------|------|
| RapidAPI Active Jobs DB | Primary search provider |
| RapidAPI LinkedIn Job Search API | Alternate provider |
| RapidAPI LinkedIn Jobs API | Third provider |
| Apollo.io | HR contact enrichment + webhook (`POST /webhook/apollo/:secret`) |
| Internal `Job` model | Auto-fetch can publish saved external listings |

**Permissions:** `external-jobs.read` (search, list saved, list contacts, enrich); `external-jobs.manage` (save, unsave, delete contacts, auto-fetch config/run). Middleware: `requireExternalJobsAccess.js` — Administrator / platform super-user bypass.

**Rate limiting:** Per-user search rate limit in `externalJob.service.js` (`checkRateLimit`).

#### C. PRD → Implementation Comparison

| PRD | Shipped | Status |
|-----|---------|--------|
| Internal job posting only | External aggregator + HR contact CRM | **Extra module** — correctly excluded from §6C PRD matrix |

#### D. Functionality Built Beyond the PRD

| Feature | Notes |
|---------|-------|
| Multi-provider job search | 3 RapidAPI sources with source-specific date-window mapping (`1d87718`) |
| Saved jobs library | Personal bookmark store per user |
| Apollo HR contacts | Outreach CRM tab — not in any PRD module |
| Auto-fetch → internal Job publish | Recruiter automation pipeline |
| Location metadata normalization | `locationMeta` + `externalJobMirrorRepair` for stale mirrors |

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-02-26 | `26dc20c` | Backend: RapidAPI search, save/unsave, rate limit | 🔵 Internal |
| 2026-02–03 | `94ffd8be` | Frontend external-jobs page | 🔵 Internal |
| 2026-04-30 | `8bd086b` | Apollo enrichment, job matching hooks | 🔵 Internal |
| 2026-06-01 | `119cc0f` | RBAC: `external-jobs.*` permission keys wired | 🔵 Internal |
| 2026-08-25 | `d328ee8` | Auto-fetch scheduler + location metadata fix | 🔵 Internal |
| 2026-09-02 | `1d87718` | Validation hardening; per-source posted-window mapping | 🔵 Internal |
| 2026-09-03 | `a95e785` | Saved-list UX polish | 🔵 Internal |

#### Page Scorecard

| PRD reqs | 0 | Full | — | Partial | — | Missing | — | Different | — | Extra | **Full submodule** |

---

### Employees (Candidates)
**Route:** `/ats/employees, /ats/employees/add, /edit/[id], /import`  |  **Module:** ATS

#### A. PRD Requirements for This Page

*IDs from §6C catalog only. ATS-AI-004 scored here because the matching-jobs sidebar is the shipped (rule-based) form of Intelligent Candidate Matching.*

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-CAND-001 | Centralised resumes, cover letters, info |
| ATS-CAND-002 | Multiple resume versions |
| ATS-CAND-003 | Tagging skills, experience, keywords |
| ATS-CAND-004 | Advanced search and filtering |
| ATS-CAND-005 | Activity history |
| ATS-CAND-006 | Bulk Excel import/export |
| ATS-CAND-007 | Compliance: SEVIS, EAD, degree, supervisor |
| ATS-CAND-008 | Compliance binder PDF/ZIP (→ public profile) |
| ATS-CAND-009 | Material change logging |
| ATS-CAND-010 | Version history material changes |
| ATS-AI-004 | Intelligent matching (jobs-for-candidate sidebar) |

#### B. What We Built

**Screens:** Employee list, Add, Edit, Import, public `/public-employee/[id]`.

**User can:** CRUD; resume upload; compliance docs; share profile via secure public link; matching jobs; Plivo click-to-call; Excel import/export; server pagination.

**Compliance sharing (ATS-CAND-008):** Public profile page with optional documents — product substitute for PDF/ZIP binder.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-CAND-001 Centralised profile | documents[], coverLetter, CRUD | 🟢 | employee.model.js |
| ATS-CAND-002 Multiple resume versions | Multiple uploads; no version workflow | 🟡 | documents[] |
| ATS-CAND-003 Skills/experience tags | Structured skills[] | 🟡 | employee.model.js |
| ATS-CAND-004 Advanced search | buildAdvancedFilter | 🟢 | employee.service.js |
| ATS-CAND-005 Activity history | activityLog + my-profile tab; fragmented | 🟡 | activityLog, my-profile |
| ATS-CAND-006 Bulk Excel import/export | Import/export endpoints | 🟢 | candidateExportXlsx.js |
| ATS-CAND-007 Compliance fields | SEVIS, EAD, degree, supervisor fields | 🟡 | employee.model.js |
| ATS-CAND-008 Compliance binder | Token-gated `/public-employee/[id]` + optional docs | 🟣 | shareCandidateProfile, public-employee page |
| ATS-CAND-009 Material change log | `placementAudit` only — not a full role/pay/supervisor/location change log | 🟡 | placement.service.js |
| ATS-CAND-010 Version history | No dedicated version-history UI; `placementAudit` is the closest trail | 🟡 | placementAudit |
| ATS-AI-004 Intelligent matching | Rule-based `getJobFit` jobs sidebar (not LLM matching) | ⚠️ | getJobFit, matching-jobs-cache.ts |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| HRMS attendance overlay | Employee profile | View punch in/out | No | attendance integration |
| Click-to-call Plivo | Employee row | One-click dial | No | plivo routes |
| Impersonation | Admin action | Login as candidate | No | impersonate middleware |
| SOP assignment modals | Employee actions | Assign candidate/offboarding SOP | No | /settings/candidates/sop |
| Bulk week-off/shift | List bulk actions | HR scheduling ops | No | bulk routes |

#### E. Git History & Evolution

| 2026-03-06 | 04759f8a | Core employees UI | 🔵 Internal |
| 2026-06+ | various | HRMS overlays, SOP | 🔵 Internal |
| Plivo | ec9ea71 | Client account migration script | 🟢 CONFIRMED CLIENT |

#### Page Scorecard

| PRD reqs | 11 (10 CAND + AI-004 on page) | Full | 3 | Partial | 6 | Missing | 0 | Different | 1 | Extra | 5 | AI-004 | ⚠️ |

---

### NEW PAGE — Referral Leads (Full Audit)

**Route:** `/ats/referral-leads` (URL-synced filters + pagination)  
**Module:** ATS — **not in PRD** (referral attribution CRM)  
**First Git:** `aa6dc41` (2026-04-22 backend); `7efc49d2` (2026-04-22 frontend)  
**Client evidence:** ⚪ Unknown

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement |
|----------------|-----------------|
| — | **None.** PRD does not define referral programs, attribution, or sales-agent commission tracking. |

#### B. What We Built

**Primary files:** `ats/referral-leads/page.tsx`, `ReferralLeadsTable.tsx`, `ReferralLeadDetailPanel.tsx`, `ReferralLeadsFilters.tsx`, `StatCards.tsx`, modals (`OverrideAttributionModal`, `AssignSalesAgentModal`, `BackfillReferralModal`, etc.), `hooks/useReferralLeadsFilters.ts`, `hooks/useReferralLeadsStats.ts`, `shared/lib/api/referralLeads.ts`, `shared/lib/ats/referral-leads-constants.ts`

**Layout:**

1. **Stat cards row** — `totalReferrals`, `converted`, `conversionRate`, `pending`, `hired`, pipeline breakdown (`pipelineCounts`), optional sales-agent leaderboard (`hiresPerSalesAgent`, `topSalesAgent`) when feature flag on.
2. **Filter bar** — free-text search; referrer user picker; link type (`SHARE_CANDIDATE_ONBOARD` → "Onboard invite", `JOB_APPLY` → "Job link"); pipeline status; date preset + custom From/To (YMD, validated — blocks fetch until range valid); sales agent filter; unassigned toggle; quick status chips (applied / hired / converted employees).
3. **Data table** — columns: Candidate (name, email, joining date), Referred by (anonymised support), Link type, Job title, **Status** (effective pipeline badge), Assigned sales agent (feature flag), Claimed timestamp, row actions menu.
4. **Detail panel** — slide-over on row click; full lead metadata, lifecycle stage, employee status post-join.
5. **Row actions** (permission-gated): Override attribution; view attribution history; assign / change / revoke sales agent; open candidate profile.

**Pipeline status (derived, not manually edited):**

Statuses: `pending`, `profile_complete`, `applied`, `interview`, `offer`, `preboarding`, `deferred`, `hired`, `joined`, `employee`, `resigned`, `rejected`, `withdrawn`, `job_removed`.

**Derivation engine:** `referralPipelineStatus.js` → `deriveReferralPipelineStatus()` reads ATS source-of-truth in precedence order: post-join lifecycle (joiningDate + `isActive`) → placement queue → offer state → interview result → application status. **Read-time overlay** `applyLifecycleOverlay()` recomputes `employee`/`resigned` when `joiningDate` passes (no ATS event fires at midnight).

**List/stats/export alignment:** `buildEffectiveStatusStages()` aggregation ensures stat cards, table badges, quick filters, and XLSX export all filter on the **same effective status** (`e4ea061`, `7f3df06`).

**Referral link minting (cross-page):**

| Source | Created from | Token | Applied when |
|--------|--------------|-------|--------------|
| `onboard` | Share Candidate Form, `POST /employees/referral-link` | HMAC `ref` (30d TTL, `referralAttribution.service.js`) | Candidate registers via `/candidate-onboard` |
| `job` | Jobs list "Share referral link", public job URL `?ref=` | Open or email-bound job ref | `browseApplyToJob` / public apply |

**Activity log events:** `REFERRAL_LINK_ISSUED`, `REFERRAL_JOB_APPLIED`, `REFERRAL_CANDIDATE_ACTIVATED`, `REFERRAL_HIRE_JOINED`, `REFERRAL_ATTRIBUTION_OVERRIDE`, `REFERRAL_CLAIM`, `referralLeads.export`.

**API surface (`employee.route.js`):**

| Method | Path | Permission |
|--------|------|------------|
| GET | `/employees/referral-leads` | `candidates.read` / `referralLeads.read` |
| GET | `/employees/referral-leads/stats` | same |
| POST | `/employees/referral-leads/export` | same → XLSX |
| POST | `/employees/referral-link` | same → `{ ref, orgId, expiresInSeconds }` |
| POST | `/employees/referral-leads/:candidateId/override` | `candidates.manage` |
| GET | `.../attribution-override-history` | read |
| POST/PATCH/DELETE | `.../sales-agent` | `candidates.manageSalesAgentAttribution` |
| GET | `.../sales-agent-history` | `candidates.read` |
| PATCH | `.../attribution-job` | sales agent manage |
| POST | `/employees/referral-leads/backfill` | sales agent manage — attach referrer to orphan candidates |

**Data model:** `ReferralAttribution` collection — `referrerUserId`, `candidateId`, `jobId`, `context` (`SHARE_CANDIDATE_ONBOARD` | `JOB_APPLY`), `batchId`, `attributionLockedAt`, sales-agent fields (`salesAgentUserId`, `salesAgentJobScope`, history arrays). Denormalized on `Employee`: `referredBy`, `referralPipelineStatus`, `referralContext`, `referralBatchId`.

**RBAC scoping:** Sales-agent role users see only leads they referred or are assigned to (`canSeeAllReferralLeads` / `buildReferralLeadsMatch`). Administrators and users with `referralLeads.read` see org-wide.

**Feature flag:** `referralSalesAgentAttribution` (config + auth payload) gates sales-agent column, modals, and leaderboard.

**Chat assistant integration:** `chatAssistant/referralLeadQueryHandler.js`, `referralLeadsAnalytics.js` — natural-language queries against referral data.

#### C. PRD → Implementation Comparison

| PRD | Shipped | Status |
|-----|---------|--------|
| No referral module | Full referral CRM with ATS-derived pipeline | **Extra module** |

#### D. Functionality Built Beyond the PRD

| Feature | Evidence |
|---------|----------|
| Sales-agent attribution + leaderboard | `salesAgentAttribution.service.js`, auto-assign on referral apply |
| Attribution override with audit history | `overrideReferralAttribution`, activity log |
| Referral backfill picker | `POST .../backfill` for orphan candidates |
| Effective-status quick filters | `quickFilterEffectiveStatusMatch` |
| Anonymised referrer display | `referralAttributionAnonymised` flag |
| XLSX export with same filters as list | `referralLeadsExcel.service.js` |

#### E. Git History & Evolution

| Date | Commit | Change |
|------|--------|--------|
| 2026-04-22 | `aa6dc41` | Initial referral leads + attribution APIs |
| 2026-04-22 | `7efc49d2` | Frontend referral-leads page |
| 2026-05-26 | `a898b3f` | Sales agent attribution APIs |
| 2026-06-01 | `6601df8` | Unified STATUS/STAGE → single derived pipeline |
| 2026-06-18 | `ecb24c8` | Server pagination; effective-status filter fix (`e4ea061`) |
| 2026-07-20 | `2107d5f` | XLSX export |
| 2026-08-11 | `ffe025b` | Sales-agent role scoping |
| 2026-09-02 | `f8f5d68` | Pagination clamp to last valid page |

#### Page Scorecard

| PRD reqs | 0 | Extra | **Full submodule** (referral CRM) |

---

### NEW PAGE — Share Candidate Form + Candidate Onboard (Full Audit)

**Routes:** `/ats/share-candidate-form` (staff) → `/candidate-onboard` (public, auth layout)  
**Module:** ATS — **not in PRD** (external candidate intake + referral attribution)  
**First Git:** `7cbf2fda` (share form FE, 2026-02-18); onboard flow in `04759f8a` wave  
**Client evidence:** ⚪ Unknown

#### A. PRD Requirements

| ID | Notes |
|----|-------|
| Partial overlap | PRD Candidate §2 "centralised profile" — intake path is extra; self-service portal partially covers CAND-001 |

#### B. What We Built — Share Candidate Form

**File:** `ats/share-candidate-form/page.tsx`

| Action | Behaviour |
|--------|-----------|
| Enter candidate email(s) | Validates email format; supports multiple recipients |
| Generate link | Builds `/candidate-onboard?token=…&adminId=…&email=…&expires=…` (24h client-side expiry) **or** calls `POST /employees/referral-link` with `source: "onboard"` for HMAC `ref` token (preferred server path) |
| Copy link | Clipboard copy for manual share |
| Send email | Dispatches invite email with onboard URL |

**Referral wiring:** Successful onboard registration calls `applyOnboardInviteReferral` / `applyReferralToCandidate` → sets `referralContext: SHARE_CANDIDATE_ONBOARD` → visible on Referral Leads page.

#### B2. Candidate Onboard (Public)

**File:** `candidate-onboard/page.tsx` (~3,600 lines)

| Step | Functionality |
|------|---------------|
| Token gate | Validates `token`, `adminId`, `email`, `expires` query params |
| Registration | Creates User + Employee (candidate) profile; links to inviting admin |
| Profile capture | Personal info, skills, experience, education, documents upload, compliance fields |
| Post-submit | Redirect to `/ats/my-profile` or sign-in; referral pipeline → `profile_complete` / `pending` |

**APIs:** Standard auth register + `PATCH /employees/me` for self-service updates after account creation.

#### C. PRD Comparison

| PRD | Shipped | Status |
|-----|---------|--------|
| HR-entered candidates only | Staff-generated invite links + self-registration | 🟣 **Different intake path** (expands CAND-001) |
| No referral tracking | Full attribution to inviting user | **Extra** |

#### D. Beyond PRD

Tokenised external onboarding URL; batch email invite; referral batch IDs; integration with Referral Leads CRM.

#### E. Git History

| Commit | Change |
|--------|--------|
| `7cbf2fda` | Share candidate form page |
| `04759f8a` | Candidate onboard UI wave |
| `aa6dc41` | Server-side HMAC referral tokens for onboard source |

---

### NEW / EXPANDED — Candidate Portal: Browse Jobs (Full Audit)

**Routes:** `/ats/browse-jobs`, `/ats/browse-jobs/[id]`  
**Module:** ATS — **partial PRD** (candidate self-service / job portal implied, not detailed)  
**First Git:** `94ffd8be` / `04759f8a` (2026-03-06 UI wave)  
**Maps to PRD IDs:** Partial — supports application flow (APP-001, APP-003) from candidate side; not a separate PRD page spec.

#### B. What We Built

**List page** (`browse-jobs/page.tsx`):

| Control | Values |
|---------|--------|
| Search | Title, company, location (debounced 300ms) |
| Job type | Full-time, Part-time, Contract, Temporary, Internship, Freelance |
| Location | Free text |
| Experience | Entry / Mid / Senior / Executive |
| Sort | Posted date, title, etc. (`sortBy` URL param) |
| Job origin | All / internal / external (`isExternalJob` flag on `PublicJob`) |
| Pagination | Server-side, 12 per page; URL-synced via `browseJobsListQuery.ts` |

**Detail page** (`browse-jobs/[id]/page.tsx`):

| Feature | Detail |
|---------|--------|
| Job display | HTML description rendering (`jobDescriptionHtml.ts`), salary, experience, location |
| Apply | `PublicJobApplyModal` → `browseApplyToJob`; passes `referralRef` from `?ref=` URL (stored in `jobReferralRef` localStorage) |
| Application rail | Shows lifecycle badge via `resolveCandidateLifecycle` (same vocabulary as My Applications) |
| Withdraw | Allowed for Applied/Screening only |
| Back navigation | Restores list query string via `readBrowseJobsListBackHref()` |

**APIs:** `getPublicJobs`, `getPublicJobById`, `browseApplyToJob` (jobs routes); referral ref verified server-side on apply.

#### C. PRD Comparison

| PRD | Shipped | Status |
|-----|---------|--------|
| Internal recruiter-driven apply | Candidate self-serve browse + apply | 🟡 Partial portal expansion |
| No referral URLs in PRD | `?ref=` HMAC attribution on apply | **Extra** (pairs with Referral Leads) |

---

### NEW / EXPANDED — Candidate Portal: My Applications (Full Audit)

**Route:** `/ats/my-applications`  
**Maps to PRD:** APP-001 (pipeline visibility), APP-003 (notifications — SSE refresh on `job_application` events)

#### B. What We Built

| Feature | Implementation |
|---------|----------------|
| Application list | `getMyApplications({ limit: 100 })` — **client-side** filter + pagination (10/page) |
| Status display | **Derived lifecycle badges** (`resolveCandidateLifecycle`) — not raw `application.status` (documented mismatch fix) |
| Status filter dropdown | Matches badge vocabulary: Applied, Screening, Shortlisted, Interview, Offer, Pre-boarding, Onboarding, Hired, Deferred, Rejected |
| Withdraw | `withdrawMyApplication` — only `Applied` / `Screening`; confirm dialog |
| Live updates | SSE `job_application` notifications trigger background refetch; `usePmRefetchOnFocus` for silent transitions |
| Selected applications | `CongratulationsBanner` for offer-stage wins |
| Documents card | `DocumentsActionCard` for compliance uploads |
| Truncation warning | If `totalOnServer > 100`, UI warns (documented ceiling in source) |

#### C. PRD Comparison

| ID | Status | Notes |
|----|--------|-------|
| APP-001 | 🟡 Partial | Pipeline visible; extra stages (Shortlisted) beyond PRD |
| APP-003 | 🟢 | Email + in-app SSE refresh on status change |

---

### NEW / EXPANDED — Candidate Portal: My Profile (Full Audit)

**Route:** `/ats/my-profile`  
**Maps to PRD:** CAND-001 (self profile), CAND-005 (activity history — partial), CAND-002 (resume — partial)

#### B. What We Built

| Section | Functionality |
|---------|---------------|
| Profile header | Avatar, completion ring (%), designation (employee role only), verification email resend |
| Personal / contact | Phone (international format), social links, address |
| Skills | Pill display with levels |
| Experience / education | Timeline cards |
| Documents | Upload list; `getDocumentDownloadUrl` |
| Matching jobs | `getMyMatchingJobs` → `JobMatchCard` grid (skill overlap) |
| Activity timeline | `listActivityLogs` filtered to candidate — addresses CAND-005 from candidate-facing side |
| APIs | `GET/PATCH /employees/me`, `GET /employees/me/matching-jobs` (auth only — no `candidates.read` required) |

#### C. PRD Comparison

| ID | Status | Notes |
|----|--------|-------|
| CAND-001 | 🟢 | Full self-service CRUD |
| CAND-002 | 🟡 | Multiple document upload; no formal version workflow |
| CAND-005 | 🟡 | Activity tab exists; not unified with recruiter-side activity log UI |

---

### Interviews
**Route:** `/ats/interviews`  |  **Module:** ATS  
**PRD source (p.3 §5):** *Interview Scheduling & Management* — nine headline bullets, 1:1 with ATS-INT-001–009.

#### A. PRD Requirements for This Page

*IDs from §6C catalog only. ATS-AI-003 scored here because assessment runs on interview recordings; ATS-AI-002 auto-schedule is scored on Applications.*

| Requirement ID | PRD Requirement (§6C / PDF p.3) |
|----------------|----------------------------------|
| ATS-INT-001 | Multi-round scheduling (Technical, Panel, HR, etc.) |
| ATS-INT-002 | Calendar sync with Google and Outlook |
| ATS-INT-003 | Built-in video interview option |
| ATS-INT-004 | Structured scoring rubrics with weighted categories (technical skills, communication, cultural fit, etc.) |
| ATS-INT-005 | Central interview dashboard (progress, scores, outcomes) |
| ATS-INT-006 | Automated reminders to candidates and interviewers |
| ATS-INT-007 | Recording and transcript generation for audit and feedback |
| ATS-INT-008 | Recruiter logs and notes linked to each interview |
| ATS-INT-009 | Secure storage and access controls for interview data |
| ATS-AI-003 | AI interview assessment from recordings/transcripts (PDF p.5) |

#### B. What We Built

**Screens:** Interviews hub (`InterviewsClient.tsx` ~3,168 lines) — table list + week calendar; `CreateInterviewModal`; `RecordingsModal`; `InterviewsFilterPanel`; waiting room `/join/room`.

**User can:** Schedule Video / In-Person / Phone interviews with candidate, recruiter, optional agents, timezone, duration, notes; reschedule/cancel; copy public join URL; score 5 rubric criteria (1–5); set tri-state `interviewResult` (pending/selected/rejected); play recordings and read transcript segments; export Excel; internal-transfer a hired candidate; filter/sort/paginate on the server.

**APIs:** `/v1/meetings`, `/v1/livekit/*`, `/v1/recordings`, `/v1/recordings/:id/transcript`. **Scheduler:** `meeting.scheduler.js` — T-15 reminders, conclusion emails, auto-end, series materialization.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-INT-001 Multi-round | Multiple meetings per candidate/job; types Video/In-Person/Phone; `agents[]` for extra interviewers. **No** round enum (Technical / Panel / HR) | 🟡 | meeting.model.js `interviewType`, CreateInterviewModal |
| ATS-INT-002 Google/Outlook sync | **Gmail:** Google auto-reschedule done. **Outlook:** not done | 🟡 | Gmail calendar auto-reschedule; Outlook calendar still missing |
| ATS-INT-003 Built-in video | LiveKit rooms (vendor substitute for PRD Agora/Daily/Twilio), waiting room, host admit | 🟢 | livekit.route.js, waiting-room.tsx |
| ATS-INT-004 Weighted rubrics | 5 fixed criteria (Technical, Communication, Problem Solving, Culture Fit, Relevant Experience), 1–5, **equal weight**, does **not** derive `interviewResult` | 🟡 | interviewRubric.js, `interviewScorecard` |
| ATS-INT-005 Dashboard | Table + week view: candidate, scores, status, outcome | 🟢 | InterviewsClient.tsx |
| ATS-INT-006 Reminders | T-15 email + in-app to invitees; post-interview conclusion pass | 🟢 | meeting.scheduler.js, sendUpcomingMeetingReminders |
| ATS-INT-007 Recording/transcript | LiveKit egress → S3; transcript segments API; AI summary when pipeline has output | 🟡 | recording.route.js, RecordingsModal |
| ATS-INT-008 Notes per interview | `Meeting.notes` + scorecard `comment`; no dedicated per-interview activity log UI | 🟡 | meeting.model.js notes |
| ATS-INT-009 Secure storage/access | `interviews.read/manage`, `meetings.read`/`meetings.record`, invite-only default, `tenantId` | 🟢 | recording.route.js, meetingAccess.service.js |
| ATS-AI-003 AI assessment | Transcripts + AI notes/summary on recording; **not** unbiased category scoring that drives the hire | 🟡 | recording transcript + AI summary |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| In-app week calendar view | Interviews hub | 7-day grid of interviews | No (PRD asked Google/Outlook **sync**, not an in-app week grid) | InterviewsClient week view |
| Waiting room / host admit | `/join/room` | Guests wait until host admits | No | waiting-room.tsx, `admittedIdentities` |
| Internal transfer | Row action | Move hired employee internally | No | `internalTransferEmployee` |
| Excel export | List toolbar | XLSX of current filters | No | exportInterviewsExcel |
| Instant interview | Schedule modal | Start a meeting on the next quarter-hour | No | CreateInterviewModal |
| Overlap detection | Schedule modal | Warn if interviewer/candidate already booked | No | interviewOverlap.ts |
| Block schedule on rejected app | Create flow | Refuse new interview if application is rejected | No | applicationPipeline.ts, meeting.service.js |

*Not extra (were mis-labelled earlier):* LiveKit **video** = INT-003 (vendor swap). Recording **AI notes** = AI-003 + Comm ATS linkage p.9. See §CORRECTION False extras.

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-03-06 | 04759f8a | Core interviews UI wave | 🔵 Internal |
| — | e469b55, c3163d9 | LiveKit setup + phase 2 | 🔵 Internal (INT-003) |
| — | ece6f36 | Reminder pipeline / meeting lifecycle | 🔵 Internal (INT-006) |
| — | interviewRubric.js | 5-criterion scorecard | 🔵 Internal (INT-004 partial) |
| 2026-09 | 757dd42a | Server-side list pagination | 🔵 Internal scale |
| — | 6e905ceb | Internal transfer UI | 🔵 Extra |
| — | 52e79769 | XLSX export | 🔵 Extra |

**Removed / split:** Internal staff meetings pulled out of ATS interviews (`52d365a`) onto `/communication/meetings`.

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 10 (9 INT + AI-003 on page) |
| Fully implemented | 4 |
| Partial | 6 |
| Missing | 0 |
| Extra features | 7 |

---

### Offers & Placement
**Route:** `/ats/offers-placement`, `/ats/offers-placement/offer-letter`  |  **Module:** ATS  
**PRD source (p.4 §6):** four headline bullets; audit splits placement-compliance auto-update → ATS-OFF-005.

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-OFF-001 | Standardised offer letter templates with digital signature support (template half) |
| ATS-OFF-002 | Digital signature support |
| ATS-OFF-003 | Version control for negotiation history and revisions |
| ATS-OFF-004 | Placement dashboard: offer status, joining dates, onboarding readiness |
| ATS-OFF-005 | Automatic compliance updates for role/title changes linked to placement |

#### B. What We Built

**Screens:** Offers & Placement queues (`offers-placement/page.tsx`), `CreateOfferForm`, `OfferLetterGeneratorWorkspace`, `ShareOfferModal`, print iframe.

**User can:** Create/edit offers (Draft/Sent/Accepted/Declined/Withdrawn); generate PDF letter from templates; email/share letter; move placements through Pending / Onboarding / Joined / Deferred / Cancelled; open pre-boarding feedback; link from Applications via Create Offer (application → Offered).

**APIs:** `/v1/offers`, `/v1/placements`. **Files:** `offer.service.js`, `placement.service.js`.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-OFF-001 Offer templates | Template-based letter workspace + PDF | 🟢 | OfferLetterGeneratorWorkspace |
| ATS-OFF-002 Digital e-sign | Static CEO signature **image** on PDF — not DocuSign/Adobe/etc. (different from PRD e-sign) | 🟣 | offer.service.js, `ceo-signature-harvinder.png` |
| ATS-OFF-003 Negotiation version control | `offerLetterHash` integrity stamp; no revision chain UI | 🟡 | offer.model.js |
| ATS-OFF-004 Placement dashboard | Queues with offer status, joining date, onboarding readiness | 🟢 | offers-placement page |
| ATS-OFF-005 Auto compliance on role change | `placementAudit` log — **manual**, not auto-applied | 🟡 | placement.service.js |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| Deferred / Cancelled queues | Placement filters | Extra sub-statuses beyond PRD dashboard | No | placement status enum |
| Share offer modal | Letter page | Copy/share letter link | No | ShareOfferModal |
| HRMS department validation | Onboarding handoff | Block join if department missing | No | onboarding edit |

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-03-06 | 04759f8a | Core offers UI | 🔵 Internal |
| — | 8e323de | Offer letter PDF + interview-to-placement | 🔵 Internal |
| — | 64d2a25 | Denormalize offerStatus on placements | 🔵 Internal |
| — | fd42e47 | Compensation snapshot protection | 🔵 Internal |

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 5 |
| Fully implemented | 2 |
| Partial | 2 |
| Missing | 0 |
| Different | 1 (static CEO image vs e-sign) |
| Extra features | 3 |

---

### Pre-boarding
**Route:** `/ats/pre-boarding`  |  **Module:** ATS  
**PRD source (p.4 §7):** first three headline bullets → PRE-001–007.

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-PRE-001 | Auto-generated pre-boarding checklist once an offer is accepted |
| ATS-PRE-002 | Identity verification |
| ATS-PRE-003 | Payroll setup |
| ATS-PRE-004 | IT account creation |
| ATS-PRE-005 | Equipment allocation |
| ATS-PRE-006 | Orientation scheduling |
| ATS-PRE-007 | Compliance acknowledgements |

#### B. What We Built

**Screens:** Pre-boarding placement list; edit modal for `assetAllocation[]` / `itAccess[]`; `PreBoardingDocumentsModal` (upload + `verifyDocument`).

**User can:** See placements in the pre-boarding stage; track document collection; record IT access and assets; jump to onboarding. Checklist is **manual / SOP**, not auto-fired on offer accept.

**APIs:** `/v1/placements` (`stage: preBoarding`), employee document verify.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-PRE-001 Auto checklist on accept | SOP / manual tasks — **no** auto-trigger on offer accept | 🟡 | pre-boarding page, SOP |
| ATS-PRE-002 Identity verification | Document verify status — no IDV vendor (Jumio/Onfido/etc.) | 🟡 | verifyDocument |
| ATS-PRE-003 Payroll setup | CTC captured on offer letter, not a payroll-system provision | 🟡 | offer letter CTC |
| ATS-PRE-004 IT account creation | `itAccess[]` checklist fields — not actual account provisioning | 🟡 | pre-boarding edit modal |
| ATS-PRE-005 Equipment allocation | `assetAllocation[]` checklist | 🟡 | pre-boarding edit modal |
| ATS-PRE-006 Orientation scheduling | SOP steps — no calendar booking | 🟡 | SOP |
| ATS-PRE-007 Compliance acknowledgements | SOP checklists / document collection | 🟡 | documents modal |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| BGV status chips | List row | Background-verification state on the queue | No | placements BGV fields |
| Split from combined stub | Route | Own page vs combined pre-boarding-onboarding | No | d0697fd3 |

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-03-06 | 04759f8a | Boarding queues | 🔵 Core wave |
| 2026-06-01 | d0697fd3 | Split combined stub into two pages | 🔵 Internal |

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 7 |
| Fully implemented | 0 |
| Partial | 7 |
| Missing | 0 |
| Extra features | 2 |

---

### Onboarding
**Route:** `/ats/onboarding`, `/ats/onboarding/edit`  |  **Module:** ATS  
**PRD source (p.4 §7):** last two headline bullets → PRE-008–009.

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-PRE-008 | Structured 7-day onboarding plan (supervisor, training kickoff, project tasks) |
| ATS-PRE-009 | Dashboard tracking onboarding progress and pending tasks for HR and supervisors |

#### B. What We Built

**Screens:** Onboarding queue (placements with status Onboarding ∪ Joined); `EditOnboardingClient` (“Edit HRMS”) for department, joining, status promotion.

**User can:** Search/paginate the joined-employee queue; see pre-boarding + BGV chips; open profile; edit HRMS fields; promote Onboarding → Joined.

**APIs:** `/v1/placements` (`stage: onboarding`).

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-PRE-008 7-day plan | Configurable task/SOP lists — not a fixed 7-day supervisor/training/project template | 🟡 | onboarding edit, SOP |
| ATS-PRE-009 Progress dashboard | Dedicated queue + status chips for HR | 🟢 | onboarding/page.tsx |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| HRMS edit / department gate | `/ats/onboarding/edit` | Assign department, employee id, joining | No | EditOnboardingClient |
| Pipeline chrome | Header | Jump links Offers → Pre-boarding → Onboarding | No | page toolbar |

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-06-01 | d0697fd3 | Split from combined stub | 🔵 Internal |
| 2026-03-06 | 04759f8a | Initial boarding queues | 🔵 Core wave |

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 2 |
| Fully implemented | 1 |
| Partial | 1 |
| Missing | 0 |
| Extra features | 2 |

---

### Recruiters
**Route:** `/ats/recruiters`, `/ats/recruiters/add`, `/edit/[id]`, public `/public-recruiter/[id]`  |  **Module:** ATS  
**PRD source (p.2 §3):** six headline bullets, 1:1 with ATS-REC-001–006.

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-REC-001 | Dedicated recruiter profiles with role-based access |
| ATS-REC-002 | Recruiter activity logs (jobs created, candidates screened, interviews scheduled) |
| ATS-REC-003 | Metrics: hires, conversion ratios, time-to-fill |
| ATS-REC-004 | Assign recruiters to specific jobs or departments |
| ATS-REC-005 | Visibility into recruiter workload |
| ATS-REC-006 | Recruiter notes and feedback on candidate/application records |

#### B. What We Built

**Screens:** Recruiters list with filters (name/domain/education/location), add/edit, notes modal, public profile, Excel import/export.

**User can:** CRUD recruiters; add/delete recruiter notes; copy/share public URL (email/WhatsApp); bulk-delete; download profile.

**APIs:** recruiter CRUD, `recruiterNotes`, `recruiterActivity.service.js` (backend log — **no** dedicated activity UI on this page). Metrics surface on **Analytics** leaderboard, not here.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-REC-001 Dedicated profiles + RBAC | Recruiter CRUD + `recruiters.read/manage` | 🟢 | ats/recruiters, permissions |
| ATS-REC-002 Activity logs | `RecruiterActivityLog` written; **no** per-recruiter activity screen | 🟡 | recruiterActivity.service.js |
| ATS-REC-003 Hires / conversion / time-to-fill | Leaderboard counts on Analytics; **no** time-to-fill | 🟡 | atsAnalytics.service.js |
| ATS-REC-004 Assign to jobs/departments | Candidate-level assign; **not** job/department roster | 🟡 | employees assign |
| ATS-REC-005 Workload visibility | Leaderboard volume only | 🟡 | Analytics leaderboard |
| ATS-REC-006 Notes on candidate/application | Recruiter-profile notes + candidate notes; thin application-notes UI | 🟡 | recruiterNotes, Employees |

*Prior condensed table scored this page 🟢 Full — incorrect. Five of six IDs are partial.*

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| Public recruiter profile | `/public-recruiter/[id]` | Shareable web profile | No (REC-001 is **internal** RBAC profiles) | RecruiterPublicProfileView |
| Excel import/export | List toolbar | Bulk recruiter file I/O | No | recruiters page handlers |
| WhatsApp / email share | Row actions | Distribute public URL | No | handleShareWhatsApp, handleSendEmail |

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-03-06 | 04759f8a | Core recruiters UI | 🔵 Internal |
| 2026-09 | 995b986 | Server-side filter/sort/export | 🔵 Internal scale |

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 6 |
| Fully implemented | 1 |
| Partial | 5 |
| Missing | 0 |
| Extra features | 3 |

---

### Analytics
**Route:** `/ats/analytics`  |  **Module:** ATS  
**PRD source (p.4 §8):** four headline bullets, 1:1 with ATS-ANA-001–004.

#### A. PRD Requirements for This Page

| Requirement ID | PRD Requirement (§6C) |
|----------------|----------------------|
| ATS-ANA-001 | Detailed metrics: applications per job, conversion rates, recruiter performance KPIs |
| ATS-ANA-002 | Hiring funnel reports to identify bottlenecks |
| ATS-ANA-003 | Exportable dashboards for management and compliance reviews |
| ATS-ANA-004 | Custom report builder for tailored insights |

#### B. What We Built

**Screens:** Stat cards, funnel, applications-over-time, recruiter leaderboard, job stats, drill-down modal, Excel export of the current dashboard.

**APIs:** `/v1/ats-analytics`, `getDrillDown`. **File:** `atsAnalytics.service.js`.

#### C. PRD → Implementation Comparison

| PRD Requirement | Current Implementation | Status | Evidence |
|-----------------|------------------------|--------|----------|
| ATS-ANA-001 Detailed metrics | Apps/job, conversion-style stats, recruiter leaderboard | 🟢 | atsAnalytics.service.js |
| ATS-ANA-002 Hiring funnel | Funnel by application status | 🟢 | applicationFunnel |
| ATS-ANA-003 Exportable dashboards | Excel dump of current widgets — not a saved/shareable dashboard | 🟡 | exportToExcel |
| ATS-ANA-004 Custom report builder | Absent | 🔴 | — |

#### D. Functionality Built Beyond the PRD

| Extra Feature | Where | What It Does | PRD Mentioned? | Evidence |
|---------------|-------|--------------|----------------|----------|
| Drill-down modal | Chart click | List the records behind a bucket | No | DrillDownModal |
| Period delta badges | Stat cards | Current vs previous window | No | DeltaBadge |

*Not extra:* Recruiter **leaderboard** = ANA-001 “recruiter performance KPIs” + REC-003. See §CORRECTION False extras.

#### E. Git History & Evolution

| Date | Commit | Change | Classification |
|------|--------|--------|----------------|
| 2026-03-06 | 04759f8a | Core analytics UI | 🔵 Internal |
| — | 4fdd04c, 28045e5 | Analytics API expand / harden | 🔵 Internal |

#### Page Scorecard

| Metric | Count |
|--------|------:|
| PRD requirements | 4 |
| Fully implemented | 2 |
| Partial | 1 |
| Missing | 1 (custom report builder) |
| Extra features | 2 |

---

### MODULE: Organization (NOT IN PRD)

**Why new:** PRD references `department` on jobs/candidates but has **no org-chart / hierarchy module**. Shipped June 2026 as a post-PRD HRMS expansion: canonical departments, reporting hierarchy, employee directory, and sandbox reorgs.

**Backend:** `orgStructure.service.js`, `orgScenario.service.js`, `orgSlot.service.js` · models `OrgUnit`, `OrgScenario`, `OrgScenarioUnit`, `OrgSlot` · routes `/v1/org-structure`, `/v1/org-scenarios`, `/v1/org-slots` · hierarchy rules in `orgTree.pure.js` (CEO → manager → supervisor → department).

**RBAC (separate grants):** `organization.structure:*` (units + chart edits), `organization.departments:*`, `organization.directory:view`, `organization.scenarios:*` (does **not** inherit from structure), `chart.read` / `structure.read` / `structure.manage` / `structure.export`.

**First commits:** `2bbcc85` (backend), `2a6478f2` (frontend UI + nav) — 2026-06-08.

| Page | Route | Functionality (code-verified) | Coverage |
|------|-------|------------------------------|----------|
| **Org Chart** | `/organization/chart` | Interactive tree (CEO → managers → supervisors → departments + members); coverage metrics (assigned/unassigned, units missing head, over-span); keyboard-friendly search combobox; collapse/expand/zoom; live drag-reparent (`chart-reparent`); unassigned-employee panel + assign modal; export CSV (compliance report), PNG, PDF; vacant org slots rendered on tree | 🟣 Beyond PRD |
| **Structure** | `/organization/structure` | Org-unit CRUD (types: CEO/manager/supervisor/department); setup checklist; paged unit table; assign head; reparent; sibling reorder; deactivate/reactivate/permanent delete; assign employees to department; **History** tab → `OrgUnit` activity logs | 🟣 Beyond PRD |
| **Departments** | `/organization/departments` | Canonical department master (name, code, chart colour); search + active/all filter; CRUD; deactivate/reactivate/delete; **Members** modal (bulk add/remove employees via `departmentId` on Employee) — shared with Jobs, Onboarding, HRMS | 🟣 Beyond PRD |
| **Directory** | `/organization/directory` | Read-only employee lookup; search name/email/department; server pagination (20); quick-view profile modal (skills, experience, qualifications) — edit links to `/ats/employees` | 🟣 Beyond PRD |
| **Scenarios** | `/organization/scenarios` | Draft reorg sandbox: create scenario, clone live org, drag-reparent units in table, diff vs live (applicable vs drift), apply reparent changes with batch audit; delete draft scenarios | 🟣 Beyond PRD |

**Cross-module links:** Department records feed Jobs (`department` field), Employees, Onboarding (`EditOnboardingClient` dept create), and org structure department nodes. Employee `departmentId` drives chart placement.

**Gaps / not built:** No PRD requirement to score. Org-slot CRUD API exists (`/v1/org-slots`) but no dedicated slots admin UI; `approveScenario` endpoint exists, UI uses apply-only flow.

---

### MODULE: Communication

| Page | Route | PRD Coverage | Extra Beyond PRD |
|------|-------|--------------|------------------|
| Email | /communication/email | 🟡 Inbox, templates partial | Unified inbox patterns |
| Chats | /communication/chats | 🟡 Real-time chat | Channel threads |
| Meetings | /communication/meetings | 🟡 Scheduling | LiveKit bridge |
| Dialer | /communication/dialer | **No** | **NEW** — outbound dialer |
| Calling | /communication/calling | Partial | Call logs |
| Recordings | /communication/recordings | Partial | Interview recordings link |
| Files | /communication/files | 🟡 Storage | S3 uploads |

**Missing PRD:** Full SSO/MFA/DLP stack, AI copilot depth, calendar sync.

---

### MODULE: Training

| Page | Route | PRD Coverage |
|------|-------|--------------|
| Curriculum | /training/curriculum | 🟢 Strong |
| Attendance | /training/attendance | 🟢 Strong |
| Mentors | /training/mentors | 🟢 |
| Students | /training/students | 🟢 |
| Evaluation | /training/evaluation | 🟡 Certs partial |
| Analytics | /training/analytics | 🟡 |
| Courses (learner) | /courses | 🟢 In ATS nav |

---

### MODULE: Projects

| Page | Route | PRD Coverage |
|------|-------|--------------|
| Projects | /apps/projects, /project-management | 🟡 Kanban V2 Jun 2026 |
| Tasks | /task/* | 🟡 |
| Teams | PM teams routes | 🟡 |
| Analytics | PM analytics | 🟡 Partial |

**PRD deliverable hash/review:** Partial — file upload exists; cryptographic hash workflow not verified full.

---

---

## 6B. Page Functionality Inventory (Code-Verified)

Every item below was traced to frontend components and/or backend routes.

### Jobs — Current Functionality

**Files:** `ats/jobs/page.tsx`, `CreateJob`, `EditJobClient.tsx`, `shared/lib/api/jobs.ts`

| Category | Functionality |
|----------|---------------|
| Navigation | List → Create → Edit; public job via `/public-job/[jobId]` |
| Search | Title, company, free-text query |
| Filters | Status, location, department, recruiter, employment type, remote |
| Sort | Title asc/desc, company asc/desc, posted date |
| Pagination | Server-side (`parseListPage`, list query params) |
| Actions | Create, Edit, Delete, Bookmark, Apply candidate, Share referral link, Bolna verification call |
| Bulk | Bulk delete selected jobs |
| Import/Export | Excel import, Excel export, template download |
| Forms | Title, description (HTML), requirements, skills, salary range, experience, job type, location, remote, department, recruiter, status, templates |
| Integrations | Bolna **job-posting** verification (extra — not in PRD); job templates from `/settings/job-templates` |
| Permissions | `jobs.read`, `jobs.manage` via `useFeaturePermissions('jobs')` |

---

### Applications — Current Functionality

**Files:** `ats/applications/page.tsx`, `jobApplications.ts`, `atsPipeline.js`

| Category | Functionality |
|----------|---------------|
| View | Table list (not kanban) |
| Statuses | Applied, Screening, Shortlisted, Interview, Offer, Hired, Rejected (reopen allowed) |
| Filters | Job, status, recruiter, date range, search |
| Pagination | Server-side |
| Actions | Change status (validated transitions), view candidate/job, export, Bolna **candidate** verification call (PRD ATS-AI-002) |
| AI / Bolna | Auto verification calls after apply (`applicationVerificationCall.scheduler.js`); manual trigger via `bolna.controller.js`; call logs/transcripts in `callRecord.service.js` |
| AI gap | **No auto-schedule interview** after candidate confirms interest — webhook does not call `createMeeting` |
| Bulk | **No multi-select bulk** — single status change per row; offer/placement workflow advances stage (Create Offer → Offered; placement queues) |
| Notifications | Email on status change (`jobApplication.service.js`) |
| Removed route | `/ats/job-applications` merged here (`da120383`) |

---

### External Jobs — Current Functionality (NEW PAGE — see §6 full audit)

**Files:** `ats/external-jobs/page.tsx` (~2,100 lines), `_components/AutoFetchModal.tsx`, `ExternalJobPreviewPanel.tsx`, `shared/lib/api/external-jobs.ts`, `external-jobs-autofetch.ts`, `external-jobs-errors.ts`, `shared/lib/ats/externalJobDisplay.ts`

| Category | Detail |
|----------|--------|
| Tabs | `search` (default), `saved`, `contacts` — URL `?tab=` |
| Providers | `active-jobs-db`, `linkedin-job-search-api`, `linkedin-jobs-api` |
| Search filters | Title, location, date posted (per-source window map), work arrangement, offset paging |
| Saved filters | `q`, source, `savedFrom`/`savedTo` (YMD), server pagination |
| Contacts filters | `q`, saved date range, card grid pagination |
| Preview panel | Full job detail, save/unsave, copy apply URL, Apollo enrich, save HR contacts |
| Auto-fetch | Admin modal: cron config, manual run, run history; publishes to internal `Job` |
| Bookmark API | `GET /saved/ids` + `GET /hr-contacts/ids` for O(1) "is saved" checks |
| Rate limit | Per-user search throttle (`externalJob.service.js`) |
| Permissions | `external-jobs.read`, `external-jobs.manage` |
| APIs | `POST /search`, `POST /save`, `GET /saved`, `GET /saved/ids`, `DELETE /saved/:id`, `POST /enrich`, `POST/GET /hr-contacts`, `GET/POST/PATCH /auto-fetch`, `POST /auto-fetch/run`, `GET /auto-fetch/runs`, `POST /webhook/apollo/:secret` |

---

### Employees — Current Functionality

**Files:** `ats/employees/page.tsx`, `EmployeePreviewPanel.tsx`, `MatchingJobsPanel.tsx`, `employee-list-query.ts`

| Category | Functionality |
|----------|---------------|
| Navigation | List, Add (`/add`), Edit (`/edit/[id]`), Import (`/import`), public `/public-employee/[id]` |
| Search/Filters | Name, email, skills, status, department, location; server pagination |
| Profile tabs | Personal, skills, experience, education, documents, compliance, notes, applications |
| Actions | CRUD, resume upload, compliance doc upload/verify, notes, assign recruiter |
| Extra | Matching jobs panel (`getJobFit` skill overlap), click-to-call (Plivo), impersonate, attendance overlay |
| Bulk | Week-off assignment, shift assignment, Excel import/export |
| SOP | Candidate SOP assign modal; offboarding SOP (settings) |
| Compliance sharing | `shareCandidateProfile` → email with secure link to `/public-employee/[id]`; optional documents & salary slips (`withDoc=1`); view-only in browser | PRD asked PDF/ZIP binder download |
| Permissions | `employees.*`, `candidates.*` dual keys |

---

### Interviews — Current Functionality

**Files:** `InterviewsClient.tsx`, `interviewRubric.js`, `meetings.ts`, `livekit.route.js`

| Category | Functionality |
|----------|---------------|
| Views | Table list + week calendar view |
| Schedule | Create meeting modal (Video/In-Person/Phone); LiveKit room |
| Video | LiveKit integration; waiting room `/join/room`; recordings modal |
| Rubric | **5 criteria** (Technical, Communication, Problem Solving, Culture Fit, Relevant Experience), ratings 1–5 |
| Rubric note | Informational only — does **not** derive `interviewResult` (tri-state pending/selected/rejected remains separate) |
| Actions | Reschedule, cancel, internal transfer, export Excel, view recording/transcript |
| Reminders | T-15 automated (`meeting.scheduler.js`) |
| Calendar / auto-reschedule | **Gmail done**; Outlook not done |
| PRD 5.4 status | 🟡 Partial — rubric exists but not weighted/job-specific; result is tri-state not rubric-derived |

---

### Offers & Placement — Current Functionality

**Files:** `ats/offers-placement/page.tsx`, `CreateOfferForm.tsx`, `OfferLetterPageClient.tsx`

| Category | Functionality |
|----------|---------------|
| Offers | Create, edit, status (Draft/Sent/Accepted/Declined/Withdrawn), PDF generation |
| Offer letter | Template-based letter page; email send |
| Offer letter signature | Static CEO signature **image** embedded on PDF (not digital/e-sign) |
| Placement queues | Pending, Onboarding, Joined, Deferred, Cancelled |
| Actions | Create offer from application, send email, edit placement, pre-boarding feedback dialog |
| Filters | Queue filter, search, pagination |

---

### Pre-boarding — Current Functionality

**Route:** `/ats/pre-boarding`  
**Split from:** `/ats/pre-boarding-onboarding` stub (`d0697fd3`, 2026-06-01)

| Functionality |
|---------------|
| Pre-boarding placement list; task/checklist tracking; document collection status; link to onboarding |

---

### Onboarding — Current Functionality

**Route:** `/ats/onboarding`, `/ats/onboarding/edit/[id]`  
**Files:** `EditOnboardingClient.tsx`

| Functionality |
|---------------|
| Onboarding task management; department assignment; HRMS validation toasts; placement status transitions; edit workflow |

---

### Recruiters — Current Functionality

**Files:** `ats/recruiters/page.tsx`, public `/public-recruiter/[id]`

| Functionality |
|---------------|
| Recruiter CRUD; public profile page; notes; filters; activity metrics in analytics (no dedicated activity UI) |

---

### Analytics — Current Functionality

**Files:** `ats/analytics/page.tsx`, `atsAnalytics.service.js`

| Functionality |
|---------------|
| Funnel by application status; timeline charts; recruiter leaderboard; job metrics |
| Missing | Custom report builder (PRD) |

---

### Referral Leads — Current Functionality (NEW PAGE — see §6 full audit)

**Files:** `ats/referral-leads/page.tsx`, `ReferralLeadsTable.tsx`, `ReferralLeadDetailPanel.tsx`, `ReferralLeadsFilters.tsx`, `StatCards.tsx`, 6 modals, `hooks/useReferralLeadsFilters.ts`, `hooks/useReferralLeadsStats.ts`, `referral-leads-list-query.ts`, `shared/lib/api/referralLeads.ts`, `shared/lib/ats/referral-leads-constants.ts`  
**Backend:** `referralLeads.service.js` (1,225 lines), `referralAttribution.service.js`, `referralPipelineStatus.js`, `referralAttribution.model.js`  
**First commit:** `aa6dc41` / `7efc49d2` (2026-04-22)

| Category | Detail |
|----------|--------|
| Stat cards | Total, converted, conversion %, pending, hired, pipeline counts, sales-agent leaderboard |
| Filters | Search, referrer, link type, pipeline status, date range, sales agent, unassigned, quick chips |
| Table columns | Candidate, Referred by, Link, Job, Status, Sales agent, Claimed, Actions |
| Pipeline | 15 statuses derived from ATS (`deriveReferralPipelineStatus`); effective overlay on read |
| Row actions | Override attribution, history, assign/change/revoke sales agent, open profile |
| Export | `POST /employees/referral-leads/export` → XLSX with same filters as list |
| Referral tokens | HMAC `ref` via `POST /employees/referral-link` (onboard + job sources) |
| Feature flag | `referralSalesAgentAttribution` |
| Permissions | `referralLeads.read`, `candidates.manage`, `candidates.manageSalesAgentAttribution` |

---

### Organization — Org Chart (NEW MODULE — see §6)

**Route:** `/organization/chart`  
**Files:** `organization/chart/page.tsx`, `_components/OrgChart.tsx`, `OrgChart.module.css`, `shared/lib/api/org-structure.ts`  
**Backend:** `orgStructure.route.js`, `orgStructure.service.js`, `orgSlot.service.js`  
**First commit:** `2a6478f2` (2026-06-08)

| Category | Functionality |
|----------|---------------|
| Data load | `GET /org-structure/tree` + `GET /org-structure/coverage` in parallel |
| Coverage cards | Active employees, assigned, unassigned, units missing head, over-span units |
| Tree UI | Hierarchical nodes by type; department colour from dept record or auto-hash; head name + member count + span warnings |
| Members | Expand department node to list employees; link to `/ats/employees/edit?id=` |
| Search | Combobox (`GET /org-structure/search`); highlights path; keyboard ↑↓/Enter; accessible results table fallback |
| View controls | Collapse to level 2, expand all, zoom in/out/fit/reset (+/−/0 keys) |
| Live edits | Drag-reparent table (`PATCH …/chart-reparent`) when `organization.structure` edit; rules enforced client + server |
| Unassigned panel | Lists employees with no department; filter; **Assign to department** modal; link to Employees |
| Vacant slots | Open headcount slots attached to tree nodes (`orgSlot.service.js` → chart) |
| Export | CSV compliance report (`GET /org-structure/export`); PNG via html-to-image; PDF via jsPDF raster |
| Permissions | `chart.read` / `structure.read` / `structure.manage`; export needs `structure.export` |

---

### Organization — Structure (NEW MODULE — see §6)

**Route:** `/organization/structure`  
**Files:** `organization/structure/page.tsx`, `_components/StructurePanel.tsx`, modals (`OrgUnitModal`, `AssignHeadModal`, `ReparentUnitModal`, `AssignToDepartmentModal`), `StructureHistoryPanel.tsx`  
**First commit:** `2a6478f2`

| Category | Functionality |
|----------|---------------|
| Tabs | **Units** (default) · **History** (org-unit activity log, filterable per unit) |
| Setup checklist | 7-step progress (CEO, managers, supervisors, dept nodes, all depts linked, heads assigned, no unassigned) driven by coverage API |
| Unit table | Server-paged (`listOrgUnitsPaged`); search; include inactive; columns: name, type, parent, head, span band, status |
| CRUD | Create/edit units (`OrgUnitModal`): types CEO/manager/supervisor/department; parent rules; link department record; `directToCeo` when dept under CEO |
| Actions | Assign head (`PATCH …/head`); reparent (`ReparentUnitModal`); sibling ↑/↓ reorder; deactivate; reactivate; permanent delete |
| Assign employees | Modal sets `departmentId` on employees (`ats.employees` edit permission) |
| History | `listActivityLogs` filtered `entityType=OrgUnit`; requires `activityLogs.read` / `activity.read` |
| Permissions | `organization.structure` create/edit/delete |

---

### Organization — Departments (NEW MODULE — see §6)

**Route:** `/organization/departments`  
**Files:** `organization/departments/page.tsx`, `_components/DepartmentsPanel.tsx`, `DepartmentModal.tsx`, `DepartmentMembersModal.tsx`  
**Backend:** existing `departments` API (shared HRMS master)  
**First commit:** `2a6478f2`

| Category | Functionality |
|----------|---------------|
| List | Server-paged (`queryDepartments`); search; active-only vs all statuses |
| Fields | Name (required), code (optional), chart colour (swatch picker or custom hex) |
| CRUD | Create, edit, deactivate, reactivate, permanent delete (blocked if linked units/employees) |
| Members modal | View current members; search employees; add/remove one or bulk; updates `departmentId` on Employee |
| Cross-use | Department dropdown on Jobs, Employees, Onboarding; colour on org chart nodes |
| Permissions | `organization.departments` create/edit/delete; members need `ats.employees` edit |

---

### Organization — Directory (NEW MODULE — see §6)

**Route:** `/organization/directory`  
**Files:** `organization/directory/page.tsx`, `_components/DirectoryProfileModal.tsx`  
**Backend:** `GET /org-structure/directory` (`queryEmployeeDirectory`)  
**First commit:** `2a6478f2`

| Category | Functionality |
|----------|---------------|
| List | Table: name, email, designation, department; server pagination (20/page) |
| Search | Debounced `q` param (name, email, department) |
| Profile modal | Read-only quick view: contact, employee ID, joining date, skills, experience, qualifications (`getCandidate`) |
| Edit path | No inline edit — subtitle directs to ATS Employees |
| Permissions | `organization.directory:view` (also granted via chart/structure read aliases) |

---

### Organization — Scenarios (NEW MODULE — see §6)

**Route:** `/organization/scenarios`  
**Files:** `organization/scenarios/page.tsx`, `_components/OrgScenariosPanel.tsx`, `shared/lib/api/org-scenario.ts`, `shared/lib/org-tree.pure.ts`  
**Backend:** `orgScenario.route.js`, `orgScenario.service.js`  
**First commit:** `2a6478f2`

| Category | Functionality |
|----------|---------------|
| List | Sidebar of scenarios (`GET /org-scenarios`); status badge (draft/applied) |
| Create | Name prompt → `POST /org-scenarios` → auto `clone` live org into sandbox |
| Sandbox edit | Drag-reparent rows in unit table (draft only); client validates hierarchy before API |
| Diff | `GET …/diff` — shows reparent changes; counts applicable vs live-drift (reference only) |
| Apply | `POST …/apply` writes applicable reparents to live org with batch audit id |
| Delete | Draft scenarios only (`DELETE …/:id`) |
| Not in UI | `PATCH …/approve` endpoint exists but no approve button exposed |
| Permissions | `organization.scenarios` / `scenarios.read` / `scenarios.manage` — **separate** from structure grants |

---

### Share Candidate Form + Candidate Onboard (NEW PAGE — see §6 full audit)

**Files:** `ats/share-candidate-form/page.tsx`, `candidate-onboard/page.tsx` (~3,600 lines)  
**First commit:** `7cbf2fda` (share form, 2026-02-18); onboard in `04759f8a` wave

| Category | Detail |
|----------|--------|
| Share form | Email validation, generate/copy onboard URL, batch send, server `POST /referral-link` |
| Onboard URL | `/candidate-onboard?token&adminId&email&expires` or HMAC `ref` token |
| Onboard flow | Self-registration, profile + documents + compliance, referral attribution |
| Referral context | `SHARE_CANDIDATE_ONBOARD` → Referral Leads pipeline |
| Post-onboard | `/employees/me` self-service; redirects to My Profile |

---

### Candidate Portal Pages (NEW / EXPANDED — see §6 full audits)

| Page | Route | Key files | Functionality |
|------|-------|-----------|---------------|
| Browse Jobs | `/ats/browse-jobs` | `browse-jobs/page.tsx`, `browseJobsListQuery.ts` | Public job catalog; 6 filters + sort + internal/external origin; server pagination (12); URL-synced state |
| Job Detail | `/ats/browse-jobs/[id]` | `browse-jobs/[id]/page.tsx`, `PublicJobApplyModal` | HTML job description; apply with `?ref=` referral; lifecycle rail; withdraw |
| My Applications | `/ats/my-applications` | `my-applications/page.tsx`, `ApplicationStatusBadge`, `candidateSelection.ts` | Derived lifecycle badges; 10-stage filter; withdraw Applied/Screening; SSE refresh; 100-app ceiling |
| My Profile | `/ats/my-profile` | `my-profile/page.tsx` (1,143 lines) | Completion ring; skills/exp/edu; documents; matching jobs; activity timeline; `PATCH /employees/me` |

---

### Public Routes (Outside ATS Nav)

| Route | Functionality |
|-------|---------------|
| `/public-job/[jobId]` | Public job posting view |
| `/public-recruiter/[id]` | Public recruiter profile |
| `/public-employee/[id]` | Public employee/candidate card |
| `/candidate-onboard` | Token-based onboarding form |
| `/join/room` | LiveKit interview waiting room |

---

## 6C. Canonical PRD Requirement ID Catalog (Module 1 — ATS)

**Rule:** One ID per numbered PRD bullet in `ATS_PRODUCT_PRD_AUDIT.md` §5.1 / `ATS-PRD-AUDIT.md` Part 2. Page audits in §6 reference **only** these IDs — no invented requirements.

**Decomposition:** 155 total = ATS 60 + Communication 38 + Training 29 + Projects 28. Each ATS ID maps 1:1 to PRD subsection bullets (e.g. Job Posting bullets 1–5 → `ATS-JOB-001`…`005`). Pre-boarding uses **9** IDs because the PRD Pre-boarding & Onboarding section lists nine distinct checklist items in the merged matrix (7.1–7.9), not five headline bullets.

| ID | PRD § | Requirement (verbatim summary) | Primary page | Status | Evidence |
|----|-------|-------------------------------|--------------|--------|----------|
| ATS-JOB-001 | 1.1 | Jobs with org, skill tags, description, job type, location | Jobs | 🟢 | job.model.js, JobsClient |
| ATS-JOB-002 | 1.2 | Excel import/export for bulk job creation and reporting | Jobs | 🟢 | jobs export/import routes |
| ATS-JOB-003 | 1.3 | Full CRUD | Jobs | 🟢 | job.route.js |
| ATS-JOB-004 | 1.4 | Search and sort | Jobs | 🟢 | job.service.js |
| ATS-JOB-005 | 1.5 | Job description templates | Jobs / Settings | 🟢 | jobTemplate.model.js |
| ATS-CAND-001 | 2.1 | Centralised resumes, cover letters, candidate info | Employees | 🟢 | employee.model.js |
| ATS-CAND-002 | 2.2 | Multiple resume versions per candidate | Employees | 🟡 | documents[] — no version workflow |
| ATS-CAND-003 | 2.3 | Tagging skills, experience, keywords | Employees | 🟡 | skills[] — no free-form tags |
| ATS-CAND-004 | 2.4 | Advanced search and filtering | Employees | 🟢 | employee.service.js |
| ATS-CAND-005 | 2.5 | Activity history (applications, interviews, feedback) | Employees / My Profile | 🟡 | activityLog — fragmented UI |
| ATS-CAND-006 | 2.6 | Bulk Excel import/export | Employees | 🟢 | import/export routes |
| ATS-CAND-007 | 2.7 | Compliance: SEVIS, EAD, degree, supervisor | Employees | 🟡 | scalar fields + doc verify |
| ATS-CAND-008 | 2.8 | Compliance binder PDF/ZIP | Employees | 🟣 | public `/public-employee/[id]` + optional docs (not PDF/ZIP file) |
| ATS-CAND-009 | 2.9 | Material change logging (role, pay, supervisor, location) | Employees | 🟡 | placementAudit only |
| ATS-CAND-010 | 2.10 | Version history for material changes | Employees | 🟡 | no dedicated version UI; placementAudit trail |
| ATS-REC-001 | 3.1 | Dedicated recruiter profiles + RBAC | Recruiters | 🟢 | ats/recruiters |
| ATS-REC-002 | 3.2 | Recruiter activity logs | Recruiters / Analytics | 🟡 | backend — no dedicated UI |
| ATS-REC-003 | 3.3 | Metrics: hires, conversion, time-to-fill | Recruiters / Analytics | 🟡 | no time-to-fill |
| ATS-REC-004 | 3.4 | Assign recruiters to jobs/departments | Employees | 🟡 | candidate-level assign only |
| ATS-REC-005 | 3.5 | Workload visibility | Analytics | 🟡 | leaderboard counts |
| ATS-REC-006 | 3.6 | Notes on candidate and application | Employees / Applications | 🟡 | candidate notes; thin app notes UI |
| ATS-APP-001 | 4.1 | Pipeline stages | Applications | 🟣 | 7 statuses vs PRD 5 |
| ATS-APP-002 | 4.2 | Notes, feedback, status | Applications | 🟡 | status per row |
| ATS-APP-003 | 4.3 | Automated notifications to candidates | Applications | 🟢 | notifyByEmail on status change |
| ATS-APP-004 | 4.4 | Audit trail of pipeline movements | Applications | 🟡 | activityLog JOB_APPLICATION_* |
| ATS-APP-005 | 4.5 | Bulk-move stages | Applications / Offers | 🟡 | single `PATCH /job-applications/:id` + offer/placement path; no multi-select batch route |
| ATS-INT-001 | 5.1 | Multi-round scheduling | Interviews | 🟡 | Video/In-Person/Phone types |
| ATS-INT-002 | 5.2 | Google/Outlook calendar sync | Interviews | 🟡 | Gmail auto-reschedule **done**; Outlook **not done** |
| ATS-INT-003 | 5.3 | Built-in video | Interviews | 🟢 | LiveKit (vendor substitute for Agora/Daily/Twilio) |
| ATS-INT-004 | 5.4 | Weighted scoring rubrics | Interviews | 🟡 | 5 criteria, equal weight, non-gating |
| ATS-INT-005 | 5.5 | Central interview dashboard | Interviews | 🟢 | InterviewsClient |
| ATS-INT-006 | 5.6 | Automated reminders | Interviews | 🟢 | meeting.scheduler.js |
| ATS-INT-007 | 5.7 | Recording and transcript | Interviews | 🟡 | egress + AI summary |
| ATS-INT-008 | 5.8 | Recruiter notes per interview | Interviews | 🟡 | meeting.notes — limited UI |
| ATS-INT-009 | 5.9 | Secure storage and access controls | Interviews | 🟢 | interviews.read/manage, recording.route.js |
| ATS-OFF-001 | 6.1 | Offer letter templates | Offers | 🟢 | OfferLetterGeneratorWorkspace |
| ATS-OFF-002 | 6.2 | Digital signature (PRD) | Offers | 🟣 | Static CEO signature image on PDF — not e-sign |
| ATS-OFF-003 | 6.3 | Negotiation version control | Offers | 🟡 | offerLetterHash — no chain |
| ATS-OFF-004 | 6.4 | Placement dashboard | Offers & Placement | 🟢 | offers-placement page |
| ATS-OFF-005 | 6.5 | Auto compliance updates on role/title change | Offers / Placement | 🟡 | placementAudit — manual |
| ATS-PRE-001 | 7.1 | Auto checklist on offer accept | Pre-boarding | 🟡 | manual/SOP tasks |
| ATS-PRE-002 | 7.2 | Identity verification | Pre-boarding | 🟡 | verifyDocument — no IDV vendor |
| ATS-PRE-003 | 7.3 | Payroll setup | Pre-boarding | 🟡 | CTC on offer |
| ATS-PRE-004 | 7.4 | IT account creation | Pre-boarding | 🟡 | itAccess[] checklist |
| ATS-PRE-005 | 7.5 | Equipment allocation | Pre-boarding | 🟡 | assetAllocation[] |
| ATS-PRE-006 | 7.6 | Orientation scheduling | Pre-boarding | 🟡 | SOP steps |
| ATS-PRE-007 | 7.7 | Compliance acknowledgements | Pre-boarding | 🟡 | SOP checklists |
| ATS-PRE-008 | 7.8 | 7-day onboarding plan | Onboarding | 🟡 | configurable tasks |
| ATS-PRE-009 | 7.9 | Onboarding progress dashboard | Pre/Onboarding | 🟢 | pre-boarding + onboarding pages |
| ATS-ANA-001 | 8.1 | Detailed metrics | Analytics | 🟢 | atsAnalytics |
| ATS-ANA-002 | 8.2 | Hiring funnel | Analytics | 🟢 | applicationFunnel |
| ATS-ANA-003 | 8.3 | Exportable dashboards | Analytics | 🟡 | Excel export |
| ATS-ANA-004 | 8.4 | Custom report builder | Analytics | 🔴 | absent |
| ATS-AI-001 | AI-1 | Profile from resume parse | Employees | 🟡 | skills + name extract |
| ATS-AI-002 | AI-2 | Call, verify, auto-schedule interviews | Applications / Bolna | 🟡 | Bolna verify; no createMeeting |
| ATS-AI-003 | AI-3 | Interview assessment | Interviews | 🟡 | AI summaries |
| ATS-AI-004 | AI-4 | Intelligent matching | Employees / Jobs | ⚠️ | rule-based getJobFit |
| ATS-AI-005 | AI-5 | Predictive insights | — | 🔴 | absent |
| ATS-AI-006 | AI-6 | Smart notifications | Cross-cutting | 🟡 | cron schedulers |
| ATS-AI-007 | AI-7 | Bias detection | — | 🔴 | absent |

**ATS roll-up (from table above):** 🟢 19 · 🟡 32 · ⚠️ 2 · 🟣 3 (APP-001 pipeline, CAND-008 binder, OFF-002 static signature image) · 🔴 4 → **strict 31.7%** (19/60) · **weighted 64.6%** using: 🟢=1.0, 🟡=0.5, ⚠️=0.75, 🟣=0.75, 🔴=0.

**All-modules roll-up (155 reqs):** verified in this document — strict **32.9%** (51/155), weighted **59.6%** (same weighting rule as §28).

| Module | Reqs | 🟢 | 🟡 | ⚠️ | 🔴 | Strict % | Weighted % |
|--------|-----:|---:|---:|---:|---:|---------:|-----------:|
| ATS (Module 1) | 60 | 19 | 32 | 2 | 7 | 31.7% | 64.6% |
| Communication (Module 2) | 38 | 11 | 16 | 3 | 6 | 28.9% | 57.2% |
| Training (Module 3) | 29 | 12 | 14 | 0 | 3 | 41.4% | 65.5% |
| Projects (Module 4) | 28 | 9 | 11 | 0 | 8 | 32.1% | 51.8% |
| **All modules** | **155** | **51** | **73** | **5** | **24** | **32.9%** | **59.6%** |

*Reconciliation:* ATS 🟢 (19) + Comm (11) + Train (12) + PM (9) = **51** strict full. Per-row Comm/Train/PM evidence: `ATS_PRODUCT_PRD_AUDIT.md` §5.2–5.4; ATS rows are fully inlined in the table above.

**PRD pages not machine-extracted:** Module–Capability Mapping (p.22) and Time & Cost Plan (p.22) were not text-extracted from the PDF; coverage claims above are from requirement bullets only.


---

---

## CORRECTION: APP-004 vs APP-005 (audit trail ≠ bulk moves)

Earlier audit drafts **swapped these IDs**. Canonical mapping (§6C):

| ID | PRD meaning | Shipped | Status |
|----|-------------|---------|--------|
| **ATS-APP-004** | Audit trail of pipeline movements | `activityLog` on application create/status/withdraw/delete | 🟡 Partial (backend log; no per-app audit UI) |
| **ATS-APP-005** | Bulk-move stages | Single `PATCH /v1/job-applications/:applicationId` + Create Offer → Offered + placement queues | 🟡 Partial (**not** 🔴 Missing — one-at-a-time works; PRD multi-select batch does not) |

**Do not score APP-004 as bulk or Missing.** The gap for bulk is **APP-005 only**, and only the **batch** portion.

---

## CORRECTION: Bolna vs PRD AI Verification (ATS-AI-002)

**Audit error (fixed):** Earlier versions listed "Bolna verification" generically under "beyond PRD." That was **incorrect** for candidate calls.

The PRD states:

> *AI Verification & Interview Scheduling: AI can call candidates to verify interest, record their responses, and, based on confirmation, schedule interviews automatically. All call logs, transcripts, and recordings are stored securely.*

This maps to **ATS-AI-002** (PRD row AI-2: "Call, verify, auto-schedule").

### Two distinct Bolna use cases

| Use case | PRD? | Status | Evidence |
|----------|------|--------|----------|
| **Candidate verification** — AI calls applicant to confirm interest; logs/transcripts stored | **Yes** (ATS-AI-002) | 🟡 **Partial** | `bolnaCandidateVerification.service.js`, `applicationVerificationCall.scheduler.js`, `bolna.controller.js`, `callRecord.service.js` |
| **Auto-schedule interview** after candidate confirms on call | **Yes** (ATS-AI-002) | 🔴 **Missing** | No `createMeeting` in Bolna webhook/disposition handler |
| **Job-posting verification** — AI calls to verify new job details from Jobs page | **No** | 🟢 Extra | `jobVerificationCall.scheduler.js`, Jobs row action |

### What is implemented (PRD-aligned)

- Bolna outbound calls to **candidates** after application (scheduler + manual API)
- Call records, transcripts, recordings stored via call record service
- Webhook ingestion from Bolna (`bolna.route.js`)

### What is missing (PRD gap)

- **Automatic interview scheduling** when candidate confirms interest on the call — the PRD's "based on confirmation, schedule interviews automatically" step is **not wired**; recruiters must schedule interviews manually in `/ats/interviews`

### What is extra (not in PRD)

- Bolna calls to verify **job postings** (quality control on listings) — PRD AI verification is **candidate-focused**, not job-focused

---

## CORRECTION: Interview Rubric (ATS-INT-004)

Prior merged audit marked ATS 5.4 as 🔴 missing. **Code review correction:**

| Aspect | PRD Expected | Current Implementation | Status |
|--------|--------------|------------------------|--------|
| Rubric criteria | Weighted scoring rubrics | 5 fixed criteria, 1–5 scale, equal weight | 🟡 Partial |
| Rubric storage | Scores drive hiring decision | `interviewScorecard` saved; **informational only** | 🟣 Different |
| Interview result | Rubric-derived | Tri-state `interviewResult`: pending/selected/rejected | 🟣 Different |
| Per-job templates | Implied | Fixed constant — no `RubricTemplate` model | 🔴 Missing |

**Evidence:** `src/constants/interviewRubric.js`, `InterviewsClient.tsx` (lines ~89–122), `meetings.ts`.

---

## CORRECTION: Offer Letter Signature (ATS-OFF-002)

**Do not describe the shipped offer letter as "digital signature."** The PRD asks for digital/e-sign (6.2); what we built is a **static CEO signature image** embedded on the generated PDF.

| Aspect | PRD (6.2) | Shipped |
|--------|-----------|---------|
| Requirement label | Digital signature | — |
| Implementation | Integrated e-sign provider | **Static CEO signature image** on PDF |
| Status | — | 🟣 **Different** — visual static CEO image; PRD e-sign provider not used |

**Evidence:** `offer.service.js`, `ShareOfferModal.tsx`, `OfferLetterGeneratorWorkspace.tsx`.

---

## 6D. Remaining ATS Pages — pointer

Full A–E audits for Interviews, Offers & Placement, Pre-boarding, Onboarding, Recruiters, and Analytics are in **§6** (same format as Jobs / Applications). Do not use this heading as a second score source.

---

## CORRECTION: Original PRD marked “not in PRD”

Re-read of *Dharwin Business Integrated ATS_Updated.pdf* (22 pages, 7 Sep 2026). These shipped features were labelled extra / “not in PRD” in earlier drafts. **They are original PRD bullets.** Implementation status does not change — only the extra/PRD tag.

| Feature previously tagged extra | Where the audit said “No” / extra | Actual PRD location | Canonical ID | Keep as extra? |
|---------------------------------|-----------------------------------|---------------------|--------------|----------------|
| Matching jobs panel (`getJobFit`) | Employees §D | p.5 *Intelligent Candidate Matching* | ATS-AI-004 | **No** — PRD (⚠️ rule-based) |
| Interview recording AI summary / AI notes | Interviews 6D “Beyond PRD” | p.5 *AI Interview Assessment*; p.9 *Interview calls → recordings/transcripts/AI notes stored under the Interview record* | ATS-AI-003 | **No** — PRD (🟡 partial) |
| Recruiter leaderboard | Analytics extra; module scorecard | p.4 §8 recruiter performance KPIs; p.2 §3 hires/conversion | ATS-ANA-001, ATS-REC-003 | **No** — PRD |
| LiveKit **video** (the call itself) | Some extras lists / “LiveKit, week view” | p.3 §5 built-in video; p.18 stack Agora/Daily/Twilio | ATS-INT-003 | **No** — vendor swap, still PRD |
| Excel dump of analytics widgets | Easy to read as extra “export” | p.4 §8 exportable dashboards | ATS-ANA-003 | **No** — PRD (🟡 Excel ≠ saved dashboard) |

**Checked and correctly extra** (PDF has no bullet for the *page* or the *specific* behaviour):

| Feature | Why the “not in PRD” tag stands |
|---------|----------------------------------|
| External Jobs + Apollo HR contacts | Job Posting §1 is **internal** jobs only |
| Referral Leads CRM | No referral module in PDF |
| Share Candidate Form as **intake** | CAND-008 is compliance binder **export**, not invite-to-register. Partial overlap with CAND-001 only |
| Organization (`/organization/*`) | No org-chart module in PDF |
| Bolna **job-posting** verification | AI-002 is **candidate** call + auto-schedule, not listing QA |
| Shortlisted / Rejected pipeline statuses | p.3 pipeline is Applied → Screening → Interview → Offer → Hired |
| In-app week calendar **grid** | p.3 + p.19 ask Google Calendar / MS Graph **sync**; week view is UI extra. INT-002 is 🟡 — Gmail auto-reschedule done, Outlook not |
| Waiting room / host admit | Not in INT-003 text |
| Internal transfer | Not in §5 |
| Public `/public-recruiter/[id]` | REC-001 is internal RBAC profiles |
| Placement Deferred / Cancelled | Not in §6 dashboard bullet |
| Dialer as PSTN outbound | Comm §3 is **in-app** audio/video, not a phone dialer |
| HRMS punch overlay, impersonation, SOP modals, bulk week-off | Not in Candidate §2 |
| Bookmarks on internal Jobs | Not in Job Posting §1 |

**Do not confuse:** CAND-008 “one-click compliance binder/**share**” ≠ Share Candidate Form. The public employee profile is the CAND-008 **substitute** (🟣); the onboard invite link is extra intake.

---

## PAGE EVOLUTION — Key Pages

### Applications

| Date | Commit | Change | Old | New | Reason |
|------|--------|--------|-----|-----|--------|
| 2026-02-23 | da120383 | Route merge | `/ats/job-applications` | `/ats/applications` | 🔵 Internal |
| 2026-05-14 | fec06a70 | Page created | — | Applications hub | 🔵 Internal |
| 2026-09 | 9fd031de | Pagination | Client | Server | 🔵 Scale |

### Pre-boarding / Onboarding

| Date | Commit | Change | Old | New | Reason |
|------|--------|--------|-----|-----|--------|
| 2026-06-01 | d0697fd3 | Split | Combined stub | Two pages | 🔵 Internal |
| 2026-03-06 | 04759f8a | Initial | — | Boarding queues | 🔵 Core wave |

### Interviews

| Date | Commit | Change | Reason |
|------|--------|--------|--------|
| 2026-03-06 | 04759f8a | Core interviews UI | 🔵 Core wave |
| Later | — | LiveKit + rubric added | 🔵 Internal |
| — | fcaa6a26 | Bolna **settings UI** removed (backend kept) | ⚪ Unknown |

---

## PRD FEATURES THAT EVOLVED

| PRD Feature | Original Implementation | Current Implementation | Git Evidence | Client? |
|-------------|------------------------|------------------------|--------------|---------|
| Application pipeline | 5 PRD stages | 7 statuses + Shortlisted/Rejected | atsPipeline.js | 🔵 Internal |
| Candidate module name | "Candidates" | "Employees" UI | nav.tsx | 🔵 Internal |
| Pre-boarding page | Single combined route | Split pages | d0697fd3 | 🔵 Internal |
| Interview scoring | Tri-state only (early) | Rubric + tri-state parallel | interviewRubric.js | 🔵 Internal |
| List pagination | Client-side | Server-side | 9fd031de | 🔵 Internal |
| Compliance export | PRD PDF/ZIP binder | Public shareable web profile + optional docs | Product chose link-based sharing over static bundle | shareCandidateProfile, public-employee page |

---

## MODULE SCORECARD — ATS

| Page | PRD Coverage | Missing | Partial | Extra | New? | Major Git Changes |
|------|--------------|---------|---------|-------|------|-------------------|
| Jobs | 🟢 High | 0 | 0 | Bolna **job** verify, bookmarks, referral | No | Pagination Sep 2026 |
| Applications | 🟡 Medium | Bulk multi-select only | Notifications + audit trail built | Shortlisted/Rejected, offer path | No | Route merge |
| External Jobs | N/A | — | — | All | **Yes** | 94ffd8be |
| Employees | 🟡 Medium | — | Resume versions, CAND-009/010 placementAudit | HRMS, telephony (matching jobs = AI-004, not extra) | Renamed | Plivo client |
| Interviews | 🟡 Medium | Outlook calendar auto-reschedule | Rounds, rubric, Gmail auto-reschedule, notes, transcripts | Week view, waiting room, internal transfer | No | LiveKit + rubric |
| Offers | 🟡 Medium | — | Hash / auto-compliance | Placement sub-status; OFF-002 static CEO image (🟣 not e-sign) | No | — |
| Pre/Onboard | 🟡 Medium | — | PRE-001–008 (8 partial) | Split pages | No | d0697fd3 |
| Recruiters | 🟡 Medium | — | Activity UI, metrics, assign (5 of 6 partial — not 🟢 Full) | Public profile | No | — |
| Analytics | 🟡 Medium | Custom builder | Excel export (ANA-003) | Drill-down, period deltas (leaderboard = ANA-001) | No | — |
| Referral Leads | N/A | — | — | All | **Yes** | 7efc49d2 |
| Share Form | N/A | — | — | All | **Yes** | 7cbf2fda |
| Candidate Portal | Partial | — | Self-service | browse/my-apps/profile | **Yes** | 94ffd8be |

---

## EVERYTHING BUILT BEYOND THE ORIGINAL PRD (Consolidated)

### New Modules
- Organization (5 pages)
- Referral Leads CRM (ATS submodule)
- External Jobs aggregator (ATS submodule)
- Help & Support

### New Pages
External Jobs, Referral Leads, Share Candidate Form, Browse Jobs, My Applications, My Profile, Organization ×5, Communication Dialer, public portals ×5, candidate-onboard, join/room

### New Workflows
- External job auto-fetch scheduler
- Bolna **job-posting** verification calls (extra — PRD AI is candidate-focused)
- Tokenized share-candidate onboarding
- Placement sub-status lifecycle (Deferred/Cancelled)
- Candidate impersonation (admin)
- LiveKit waiting room (host admit — extra UX on INT-003)

### New Integrations
- Plivo click-to-call (**PRD vendor substitute** for telephony in COMM module; extra: browser dialer UI) (extra)
- Bolna voice AI — candidate verify = PRD ATS-AI-002 (partial); job verify = extra; TTS vendor differs from PRD ElevenLabs/AWS Polly row
- Apollo HR contacts (external jobs)
- RapidAPI external job providers
- LiveKit video egress/recordings (**PRD vendor substitute** for Agora/Daily/Twilio — COMM-VOICE capability, not new scope)

### New Automations
- External job auto-fetch cron
- Bolna **job-posting** verification scheduler (extra)

*Not extra:* Meeting T-15 reminders = INT-006; application status emails = APP-003.

### New AI (beyond PRD scope/depth)
- Bolna **job-posting** verification only (candidate Bolna is PRD ATS-AI-002 — see correction below)
- Recording AI summary (partial PRD ATS-AI-003)
- Rule-based job fit (PRD ATS-AI-004 implemented differently — not ML)
- PM Assistant / Sage chat (other modules)

---

## PRD FUNCTIONALITY NOT YET BUILT (Top Gaps)

Full 155-row matrix: `ATS_PRODUCT_PRD_AUDIT.md` §5. **ATS 60 rows are inlined in §6C above.**

| Priority | Gap | ID | Module |
|----------|-----|-----|--------|
| Medium | True e-sign provider (OFF-002 is 🟣 — static CEO image shipped instead) | ATS-OFF-002 | ATS |
| Medium | Outlook calendar auto-reschedule (Gmail done; Outlook not) | ATS-INT-002 | ATS |
| Medium | Bulk multi-select stage moves (partial: single row + offer/placement path) | ATS-APP-005 | ATS |
| Medium | Custom analytics report builder | ATS-ANA-004 | ATS |
| Low | Deeper material-change log / version UI (CAND-009/010 partial via placementAudit) | ATS-CAND-009/010 | ATS |
| Medium | SSO/MFA/DLP | COMM-SEC-* | Communication |
| Medium | PM deliverable hash/review chain | PM-009–011 | Projects |
| Medium | AI auto-schedule after Bolna confirmation | ATS-AI-002 | ATS |
| Medium | Predictive/bias AI | ATS-AI-005/007 | ATS |
| Low | Optional stack items not shipped (Prisma/Postgres/Casbin) | — | Platform — **Express is PRD-allowed** |

---

## MASTER FEATURE MATRIX (Extended — ATS)

| Module | Page | Feature | PRD? | Status | Extra? | History? | Client? | Evidence |
|--------|------|---------|------|--------|--------|----------|---------|----------|
| ATS | Jobs | CRUD | Yes | 🟢 | No | — | No | job.route.js |
| ATS | Jobs | Excel import/export | Yes | 🟢 | No | — | No | jobs.ts |
| ATS | Jobs | Bolna **job** verify | No | 🟢 | **Yes** | Feb 2026+ | Unknown | jobVerificationCall.scheduler.js |
| ATS | Applications | Bolna **candidate** verify (ATS-AI-002) | **Yes** | 🟡 | No | — | No | bolnaCandidateVerification.service.js |
| ATS | Applications | Auto-schedule after Bolna confirm (ATS-AI-002) | **Yes** | 🔴 | No | — | No | no createMeeting in webhook |
| ATS | Jobs | Bookmarks | No | 🟢 | Yes | — | No | jobs API |
| ATS | Applications | 7-status pipeline | Yes | 🟣 | Yes | Expanded | No | atsPipeline.js |
| ATS | Applications | Bulk multi-select stage | Yes | 🟡 | No | Single + offer/placement | No | offer.service.js |
| ATS | Employees | Profile CRUD | Yes | 🟢 | No | — | No | employee.model.js |
| ATS | Employees | Compliance share (ATS-CAND-008) | Yes | 🟣 | No | — | No | public-employee page |
| ATS | Employees | Click-to-call | No | 🟢 | Yes | — | **Yes** | ec9ea71 Plivo |
| ATS | Employees | Matching jobs | No | 🟢 | Yes | — | No | MatchingJobsPanel |
| ATS | Interviews | LiveKit video (COMM-VOICE vendor swap) | Yes | 🟢 | No | Added | No | livekit.route.js |
| ATS | Interviews | 5-criterion rubric | Yes | 🟡 | No | Added | No | interviewRubric.js |
| ATS | Interviews | Calendar sync / auto-reschedule | Yes | 🟡 | No | Gmail done; Outlook not | No | — |
| ATS | Offers | PDF offer letter | Yes | 🟢 | No | — | No | offer.service.js |
| ATS | Offers | E-sign | Yes | 🟣 | No | Static CEO image (not provider e-sign) | No | offer PDF |
| ATS | External Jobs | Search/saved/contacts | No | 🟢 | Yes | 94ffd8be | Unknown | external-jobs page |
| ATS | Referral Leads | CRM pipeline | No | 🟢 | Yes | 7efc49d2 | Unknown | referral-leads |
| ATS | Analytics | Funnel | Yes | 🟢 | No | — | No | atsAnalytics |
| ATS | Analytics | Custom reports | Yes | 🔴 | No | — | No | — |

---

*Appendix: **ATS 60 requirements** are fully inlined in §6C. Comm/Train/PM module roll-ups are in §6C (155 total). Per-row evidence for modules 2–4: `ATS_PRODUCT_PRD_AUDIT.md` §5.2–5.4. This evolution audit reorganizes evidence by PAGE and adds Git evolution.*
---

---

## 7. Page-by-Page PRD Comparison (Summary)

See Section 6 for per-page A–E detail. **Strongest ATS pages:** Jobs, Interviews (video), Offers, Placement, Analytics funnel. **Weakest:** E-sign, calendar sync, AI auto-schedule depth. **Applications stage moves:** single per row + Create Offer → Offered + Placement queues (no bulk multi-select). **Compliance sharing:** public profile page (ATS-CAND-008).

---

## 8. Functionality Built Beyond PRD

| Category | Examples | Evidence |
|----------|----------|----------|
| New pages | External Jobs, Referral Leads, Share Candidate Form, Org module, Dialer | routes, git |
| Candidate portal | browse-jobs, my-applications, my-profile | /ats/* |
| Public pages | public-job, public-recruiter, public-employee, candidate-onboard | app routes |
| Telephony | Plivo click-to-call = **PRD COMM-VOICE vendor substitute** (extra: browser dialer UI); Bolna **job** verify = extra | plivo, jobVerificationCall.scheduler.js |
| HRMS on ATS | Attendance, week-off, shift on employees | employee routes |
| SOP modules | Candidate SOP, offboarding SOP settings | /settings/* |
| Pipeline extras | Shortlisted, Rejected+reopen | atsPipeline.js |
| Auto-fetch | External job scheduler | externalJobs scheduler |
| Sales agent dashboard | Non-PRD role dashboard | dashboard widgets |

---

## 9. New Pages Added Beyond PRD

1. **External Jobs** — Search/Saved/Contacts tabs (see Section 6)
2. **Referral Leads** — CRM pipeline
3. **Share Candidate Form** — Token onboarding
4. **Browse Jobs / My Applications / My Profile** — Candidate self-service
5. **Organization** (5 pages — Chart, Structure, Departments, Directory, Scenarios; see §6 + §6B)
6. **Communication Dialer**
7. **Public portals** (job, recruiter, employee, onboard, join/room)
8. **Help & Support**

---

## 10. New Modules Added Beyond PRD

- **Organization** — full module
- **Referral Leads CRM** — ATS submodule
- **External Jobs** — ATS submodule
- **Help & Support**
- **Dialer** — Communication submodule

---

## 11–12. New Screens/Workflows Beyond PRD

- External job auto-fetch workflow
- Bolna job verification call workflow
- Tokenized share-candidate onboarding
- LiveKit waiting room (`/join/room`)
- Placement sub-status workflow (Pending→Onboarding→Joined→Deferred→Cancelled)
- Candidate impersonation (admin)
- Job-applications page merge into applications hub

---

## 13. PRD Functionality Missing

| Module | Page | Requirement | Missing Portion |
|--------|------|-------------|-----------------|
| ATS | Offers | ATS-OFF-002 | True e-sign provider — shipped **static CEO image** instead (🟣 Different) |
| ATS | Interviews | ATS-INT calendar | Google/Outlook calendar sync |
| ATS | Analytics | ATS-ANA | Custom report builder |
| ATS | AI | ATS-AI-* | Predictive hiring, bias detection, auto-schedule post-Bolna |
| Comm | Security | SSO/MFA/DLP | Enterprise security stack |
| Platform | Stack (optional PRD items) | — | Prisma/Postgres/Casbin not used; Meilisearch was scale option not baseline; Express ✅ per PRD p.19 |

---

## 14. PRD Functionality Partially Implemented

| Requirement | Current State | Gap |
|-------------|---------------|-----|
| Resume parsing | Upload works | Full structured parse incomplete |
| Training certs | Evaluation module | Full cert issuance partial |
| PM deliverable review | Uploads | Hash/review chain unverified |
| Interview rubric | 5 criteria in UI (1–5 scale); tri-state interviewResult separate | PRD wanted weighted rubric driving decision |
| AI job fit | Rule-based skill overlap | Not ML |
| Bulk stage moves (ATS-APP-005) | Single row + Create Offer + Placement queues (`offer.service.js`) | No multi-select bulk API on Applications |
| Audit trail (ATS-APP-004) | activityLog on stage changes (`jobApplication.controller.js`) | No dedicated per-application audit UI |

---

## 15. PRD Functionality Implemented Differently

| Page | PRD Says | Product Does | Evidence |
|------|----------|--------------|----------|
| Applications | Bulk multi-select (APP-005) | Single row + Create Offer → Offered + Placement queues | offer.service.js, offers-placement |
| Applications | 5-stage pipeline | 7 statuses + Shortlisted/Rejected | atsPipeline.js |
| Candidates | "Candidates" | "Employees" UI label | nav.tsx |
| Applications UI | Pipeline/kanban implied | Table + filters | ApplicationsClient |
| Offer letter signature (OFF-002) | Integrated digital e-sign (PRD) | Static CEO signature image on PDF | offer.service.js |
| Compliance export (ATS-CAND-008) | PDF/ZIP binder download | Token-gated public profile `/public-employee/[id]` with optional docs | shareCandidateProfile, public-employee page |
| Pre-boarding | Single module | Split pre-boarding + onboarding pages | d0697fd3 |

---

## 16. Git Product Evolution

| Phase | Date | Commits | What Happened |
|-------|------|---------|---------------|
| Early stubs | Feb 2026 | 7cbf2fda, 94ffd8be | Share form, external jobs, browse-jobs |
| Core ATS wave | Mar 2026 | 04759f8a | Jobs, employees, interviews, offers, boarding, analytics, recruiters |
| Consolidation | Feb–May 2026 | da120383, fec06a70 | Job-applications → applications |
| CRM expansion | Apr 2026 | 7efc49d2 | Referral leads |
| Lifecycle split | Jun 2026 | d0697fd3 | Pre-boarding/onboarding split; Bolna settings UI removed fcaa6a26 |
| Scale | Sep 2026 | 9fd031de, 757dd42a | Server pagination across lists |
| PM V2 | Jun 2026 | various | Kanban/project management refresh |

---

## 17. Page-by-Page Git History

| Page | Created | Major Changes | Removed? |
|------|---------|---------------|----------|
| Jobs | 04759f8a | Pagination Sep 2026, Bolna | No |
| Applications | fec06a70 | Absorbed job-applications | job-applications deleted |
| External Jobs | 94ffd8be | Auto-fetch, contacts | No |
| Employees | 04759f8a | HRMS overlays, Plivo | No |
| Referral Leads | 7efc49d2 | — | No |
| Pre-boarding/Onboarding | 04759f8a | Split d0697fd3 | combined stub deleted |
| Interviews | 04759f8a | LiveKit, rubric, week view | No |
| Bolna settings UI | — | — | fcaa6a26 removed (backend remains) |

---

## 18. Client-Requested Changes

| Page | Change | Date | Commit | Evidence | Confidence |
|------|--------|------|--------|----------|------------|
| Telephony | Plivo account migration | — | ec9ea71 | Commit message "client account migration" | 🟢 CONFIRMED |

**No matches** in frontend git for: "client asked", "UAT feedback", "customer request", "stakeholder". Most changes: 🔵 INTERNAL or ⚪ UNKNOWN.

---

## 19. Features Built Then Changed

| Feature | Original | Current | Commits | Classification |
|---------|----------|---------|---------|----------------|
| Application hub | /ats/job-applications | /ats/applications | da120383 | 🔵 Internal |
| Pre-boarding UI | Combined stub page | Separate pages | d0697fd3 | 🔵 Internal |
| Pagination | Client-side | Server-side | 9fd031de | 🔵 Internal |
| Bolna config | Settings UI | Backend-only | fcaa6a26 | ⚪ Unknown |
| Pipeline stages | PRD 5-stage | 7-stage with Shortlisted/Rejected | atsPipeline.js | 🔵 Internal |

---

## 20. Removed Functionality

| Feature | Page | Removal | Commit | Current State |
|---------|------|---------|--------|---------------|
| Job Applications page | /ats/job-applications | Merged | da120383 | Use /ats/applications |
| Pre-boarding-onboarding stub | /ats/pre-boarding-onboarding | Split | d0697fd3 | Two pages |
| Bolna settings UI | /settings/* | Deleted UI | fcaa6a26 | Backend Bolna API remains |

---

## 21. PRD Outdated Areas

| PRD Area | PRD Description | Current Product | Update Needed |
|----------|-----------------|-----------------|---------------|
| Tech stack | NestJS/Postgres (optional) | Express/Mongo (Express allowed p.19) | Document actual stack; NestJS not mandatory |
| Candidate naming | Candidates module | Employees UI | Terminology |
| Pipeline | 5 stages | 7 statuses | Workflow doc |
| Compliance | PDF/ZIP binder download | Public shareable profile page with optional docs | Feature spec updated |
| E-sign | Integrated | Email+image | Feature spec |
| Calendar | Google/Outlook sync | Gmail auto-reschedule done; Outlook not | Finish Outlook |
| AI | ML predictions | Rule-based + Bolna | Scope AI |

---

## 22. Current Product Map

### ATS
- Jobs (list, create, edit, import, export, bookmarks, Bolna)
- Applications (table pipeline, 7 statuses)
- External Jobs (search, saved, contacts)
- Employees (profiles, compliance, HRMS, telephony)
- Referral Leads CRM
- Share Candidate Form
- Candidate portal (browse, my-apps, my-profile)
- Recruiters (+ public profiles)
- Interviews (LiveKit, rubric, week view, recordings)
- Offers & Placement (PDF, placement queues)
- Pre-boarding, Onboarding
- Analytics (funnel)
- Courses (learner, in ATS nav)

### Organization (new)
- **Org Chart** — interactive hierarchy, coverage metrics, search, zoom, live reparent, exports
- **Structure** — unit CRUD, setup checklist, head assignment, history tab
- **Departments** — canonical dept master + member assignment
- **Directory** — read-only employee lookup + profile modal
- **Scenarios** — draft reorg sandbox, diff, apply to live

### Communication
- Email, Chats, Meetings, Dialer, Calling, Recordings, Files

### Training
- Curriculum, Attendance, Mentors, Students, Evaluation, Analytics, Courses

### Projects
- Projects, Tasks, Kanban, Teams, Analytics

### Platform
- Dashboard, Logs, Settings (10+ sub-pages), Help

---

## 23. Master Page Matrix

| Module | Page | In PRD? | PRD Func | Current Func | Missing | Extra | New? | Git Changes | Client? |
|--------|------|---------|----------|--------------|---------|-------|------|-------------|---------|
| ATS | Jobs | Yes | Full CRUD, templates, board | +Bolna, bookmarks, referral | — | High | No | Pagination | No |
| ATS | Applications | Yes | Pipeline | 7-status table | Bulk multi-select only | Shortlisted/Rejected, offer/placement moves | No | Merged route | No |
| ATS | External Jobs | No | — | 3-tab aggregator | — | All | **Yes** | 94ffd8be | Unknown |
| ATS | Employees | Yes | Candidate CRM | +HRMS, telephony, public profile share | — | High | Renamed | Plivo client | Partial |
| ATS | Interviews | Yes | Schedule, evaluate | +LiveKit, rubric, Gmail auto-reschedule | Outlook auto-reschedule | Video, week view | No | LiveKit | No |
| ATS | Offers | Yes | Offers, placement | PDF, queues | True e-sign provider (static CEO image is 🟣) | Placement sub-status | No | — | No |
| ATS | Analytics | Yes | Dashboards | Funnel | Custom builder | — | No | — | No |
| ATS | Referral Leads | No | — | CRM | — | All | **Yes** | 7efc49d2 | Unknown |
| Org | Chart | No | — | Interactive tree, search, exports, live reparent | — | All | **Yes** | 2a6478f2 | No |
| Org | Structure | No | — | Unit CRUD, checklist, heads, history | — | All | **Yes** | 2a6478f2 | No |
| Org | Departments | No | — | Dept master + members | — | All | **Yes** | 2a6478f2 | No |
| Org | Directory | No | — | Read-only employee lookup | — | All | **Yes** | 2a6478f2 | No |
| Org | Scenarios | No | — | Reorg sandbox + apply | — | All | **Yes** | 2a6478f2 | No |
| Comm | Dialer | No | — | Outbound dial | — | All | **Yes** | — | Unknown |

---

## 24. Master Feature Matrix (ATS sample)

| Module | Page | Feature | PRD? | Status | Extra? | History? | Client? |
|--------|------|---------|------|--------|--------|----------|---------|
| ATS | Jobs | CRUD | Yes | 🟢 | No | Pagination | No |
| ATS | Jobs | Bolna verify | No | 🟢 | Yes | Added Feb+ | Unknown |
| ATS | Employees | Compliance share (ATS-CAND-008) | Yes | 🟣 | No | — | No |
| ATS | Employees | Click-to-call | No | 🟢 | Yes | Plivo | **Yes** |
| ATS | Applications | Bulk stage | Yes | 🟡 | No | Single + offer path | No |
| ATS | Interviews | LiveKit video (COMM-VOICE) | Yes | 🟢 | Vendor swap | Added | No |
| ATS | Interviews | Calendar sync | Yes | 🟡 | No | Gmail done; Outlook not | No |
| ATS | Offers | PDF offer | Yes | 🟢 | No | — | No |
| ATS | Offers | E-sign | Yes | 🟣 | No | Static CEO image (not provider e-sign) | No |

---

## 25. PRD Coverage Scorecard

### ATS Module

| Page | PRD IDs | Full | Partial | Missing | Different | Extra |
|------|---------|------|---------|---------|-----------|-------|
| Jobs | JOB-001–005 | 5 | 0 | 0 | 0 | 4+ |
| Applications | APP-001–005 (+AI-002 on page) | 1 | 4 | 0 | 1 | 3 |
| Employees | CAND-001–010 (+AI-004 on page) | 3 | 6 | 0 | 1 | 5 |
| Interviews | INT-001–009 (+AI-003 on page) | 4 | 6 | 0 | 0 | 7 |
| Offers | OFF-001–005 | 2 | 2 | 0 | 1 | 3 |
| Pre/Onboarding | PRE-001–009 | 1 | 8 | 0 | 0 | 4 |
| Recruiters | REC-001–006 | 1 | 5 | 0 | 0 | 3 |
| Analytics | ANA-001–004 | 2 | 1 | 1 | 0 | 2 |
| AI (cross) | AI-001–007 | 0 | 4 | 2 | 1 | 1 |

**Note:** Page scorecards count rows on that page (Applications includes cross-page `ATS-AI-002`). **Authoritative ATS totals:** §6C → **19 🟢 / 32 🟡 / 2 ⚠️ / 3 🟣 / 4 🔴 = 60 IDs**. **All-modules:** §6C roll-up table → **51/155 strict (32.9%)**, **59.6% weighted**. Math: ATS 19 + Comm 11 + Train 12 + PM 9 = 51 full.

---

## 26. Product Expansion Beyond PRD

**Net:** Product is **broader than PRD** in ATS (external jobs, CRM, portal, telephony, HRMS overlays, public compliance profiles) but **shallower** in some enterprise items (e-sign, calendar, AI/ML depth).

---

## 27. Recommended PRD Updates

1. Rename Candidates → Employees; document 7-stage pipeline.
2. Add External Jobs, Referral Leads, Share Candidate Form, candidate portal pages.
3. Add Organization module.
4. Document actual stack: Express (PRD-allowed) + MongoDB.
5. Document compliance sharing as public profile page (`/public-employee/[id]`) rather than PDF/ZIP binder; note e-sign as phased/deferred.
6. Document LiveKit interview flow and 5-criterion rubric.
7. Defer Prisma/Postgres/Casbin; note Meilisearch was PRD scale option not baseline.
8. Add Dialer and Plivo/Bolna integrations explicitly.

---

## 28. Evidence / Methodology

### Sources
- PRD PDF (155 requirements)
- `ATS_PRODUCT_PRD_AUDIT.md` (merged prior audit)
- `uat.dharwin.frontend/shared/layouts-components/nav.tsx` — page inventory
- `uat.dharwin.frontend/app/(components)/(contentlayout)/ats/**` — page components
- `uat.dharwin.backend/src/routes/v1/**` — API surface
- `uat.dharwin.backend/src/services/atsPipeline.js` — pipeline truth
- Git log frontend/backend (follow, name-status, deleted paths)

### Status legend
- 🟢 Fully implemented
- 🟡 Partially implemented
- 🔴 Missing
- 🟠 UI only
- 🔵 Backend only
- 🟣 Implemented differently
- ⚫ Historically removed

### Coverage formula

- **Strict:** count 🟢 only.
- **Weighted:** 🟢=1.0, 🟡=0.5, ⚠️=0.75, 🟣=0.75, 🔴/🟠/🔵=0. Extra features excluded.
- **155 reqs:** ATS 60 + Comm 38 + Train 29 + PM 28. Full per-row matrix: `ATS_PRODUCT_PRD_AUDIT.md` §5.

### Quality checklist
- [x] Entire PRD read (via prior audit + requirement IDs)
- [x] Actual routes inventoried from nav + app directory
- [x] Every major ATS page audited (A–E or condensed)
- [x] New pages identified with screens/tabs
- [x] Git history for major pages
- [x] Client claims evidence-based only
- [x] No code modified

---

## Final Answers (Step 22)

### 1. What did the original PRD ask us to build?
Four-module integrated suite (ATS, Communication, Training, Projects) with 155 requirements: full hiring lifecycle, compliance binders, e-signatures, calendar sync, kanban PM, training LMS, comms hub, AI features — PRD allows Express (p.19); shipped Express/MongoDB.

### 2. What did we actually build?
Express/Mongo/Next.js product with **7 nav modules**, richer ATS than PRD (external jobs, referral CRM, candidate portal, telephony), solid jobs/interviews/offers/analytics, partial comm/training/PM, missing enterprise compliance and AI depth.

### 3. Per PRD page — what was built?
See **Section 6** (page audits) and **Section 23** (master page matrix). Jobs/Recruiters strongest; Outlook calendar and custom reports weakest. Compliance sharing delivered via public employee profile page. Offers signature is 🟣 (static CEO image, not e-sign).

### 4. Missing PRD functionality?
Binder PDF/ZIP, true e-sign **provider** (static CEO image shipped — 🟣), Outlook calendar auto-reschedule, **bulk multi-select** on Applications (single + offer/placement path exists), custom analytics builder, ML AI, SSO/MFA/DLP, PRD tech stack. *(Compliance package sharing via public profile — ATS-CAND-008.)*

### 5. Partial PRD functionality?
Resume parse, training certs, PM hash review, interview calendar/rubric weighting, AI job fit, material-change logging (CAND-009/010).

### 6. Implemented differently?
7-stage pipeline, Employees naming, table not kanban applications, email PDF offers, split pre-boarding/onboarding, informational rubric vs weighted.

### 7. Entirely new pages?
External Jobs, Referral Leads, Share Candidate Form, candidate portal pages, Organization (5), Dialer, public portals, Help.

### 8. New page screens/tabs?
Documented in Section 6 and 6B (e.g. External Jobs: Search/Saved/Contacts).

### 9. Entirely new modules?
Organization, Referral CRM, External Jobs submodule, Dialer.

### 10. Beyond PRD functionality?
~72 items — Sections 8, 26, and consolidated list in 6B appendix.

### 11. Built then changed?
Section 19 — pagination, route merges, pipeline expansion, Bolna UI removal, rubric addition.

### 12. Removed?
Section 20 — job-applications page, combined boarding stub, Bolna settings UI.

### 13. Confirmed client requests?
Plivo migration (ec9ea71) only.

### 14. Likely client requests?
None evidenced in commit messages beyond Plivo.

### 15. Internal engineering changes?
Majority — core wave, pagination, route consolidation, lifecycle splits.

### 16. Unknown reasons?
Bolna settings UI removal, some CRM additions.

### 17. Outdated PRD areas?
Section 21 — stack, naming, pipeline, compliance, AI scope, rubric model.

### 18. What does current ATS contain?
Section 22 Current Product Map.

---

*End of ATS PRD / Product / Git Evolution Audit*
