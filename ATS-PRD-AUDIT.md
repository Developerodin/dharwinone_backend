<style>
/* Wide traceability tables scroll horizontally instead of being clipped. */
table { display: block; width: max-content; max-width: 100%; overflow-x: auto; }
</style>

# ATS Module — PRD Review / Functionality Audit

**Audit date:** 7 September 2026  
**Scope:** `uat.dharwin.backend` + `uat.dharwin.frontend`  
**Method:** Two-way repository inspection. No runtime testing. No code changes.  
**Direction A:** PRD requirement → code (Parts 1–12).  
**Direction B:** Independent ATS inventory → PRD coverage (Parts 13–16). Direction B does not assume the PRD describes the current product.  
**Auditor note:** Classifications are based on traced code paths, not UI labels or schema presence alone. Helper functions, indexes, and generic buttons are not counted as extra features.

---

## PART 1 — EXECUTIVE SUMMARY

### Requirement counts (60 individual PRD requirements audited)

| Status | Count |
|--------|------:|
| 🟢 Fully implemented | **19** |
| 🟡 Partially implemented | **29** |
| 🟠 UI / placeholder only | **0** (as primary status; see Part 6) |
| 🔵 Backend only | **0** (as primary status) |
| ⚠️ Implemented differently | **2** |
| 🔴 Not implemented | **10** |
| 🟣 Extra functionality (outside PRD) | **32** meaningful capabilities (27 fully, 4 partial, 1 placeholder) |

### Overall PRD coverage

| Method | Score |
|--------|------:|
| **Strict** (only 🟢 counts as done) | **31.7%** (19 ÷ 60) |
| **Weighted** (🟢=1.0, 🟡=0.5, ⚠️=0.75, 🔴/🟠/🔵=0) | **58.3%** (35 ÷ 60) |

**How the percentage was calculated**

- Each of the **60** individually numbered PRD requirements receives exactly one primary status.
- **Strict coverage** counts only requirements verified end-to-end as 🟢.
- **Weighted coverage** gives partial credit where meaningful work exists but the full PRD requirement is not met: 🟡 = 0.5, ⚠️ = 0.75.
- UI buttons, routes, model fields, and API endpoints **without verified end-to-end behavior** are not counted as fully implemented.
- Extra functionality outside the PRD does **not** increase the coverage percentage.

### Headline findings

1. **Strongest areas:** Job posting management, core application pipeline, LiveKit video interviews, offer letter generation, placement queues, ATS analytics.
2. **Weakest areas:** Compliance binder / material-change audit, e-signature, calendar sync, interview scoring rubrics, bulk application moves, custom reporting, predictive AI, bias detection.
3. **Largest PRD-vs-product gap:** Richer pipeline than PRD (Shortlisted, Rejected, placement sub-stages, referral leads, external jobs), but compliance and several AI items are scaffolded or rule-based.
4. **AI gap:** Resume parsing creates skills + name only. Matching is deterministic skill scoring. Bolna calls verify interest but do not auto-schedule interviews.

---

## PART 2 — MASTER PRD TRACEABILITY MATRIX

| # | PRD Module | Requirement | Status | Evidence | Files/Components | Gap | Notes |
|---|------------|-------------|--------|----------|------------------|-----|-------|
| 1.1 | Job Posting | Jobs with org, skill tags, description, job type, location | 🟢 | Job model + CRUD APIs + UI | `job.model.js`, `job.route.js`, `ats/jobs/create/page.tsx` | — | End-to-end verified |
| 1.2 | Job Posting | Excel import/export | 🟢 | Export/import/template endpoints | `POST /v1/jobs/export/excel`, `import/excel`, `jobs.ts` | — | Bulk + reporting |
| 1.3 | Job Posting | Full CRUD | 🟢 | All CRUD routes + UI | `job.controller.js`, `ats/jobs/page.tsx` | — | Includes delete |
| 1.4 | Job Posting | Search and sort | 🟢 | queryJobs + filter panel | `job.service.js`, `JobsFilterPanel` | — | Faceted filters |
| 1.5 | Job Posting | Job description templates | 🟢 | JobTemplate CRUD | `jobTemplate.model.js`, `settings/job-templates` | — | Create-from-template |
| 2.1 | Candidate(Employee) | Centralised resumes, cover letters, info | 🟢 | documents[], coverLetter, profile CRUD | `employee.model.js`, `jobApplication.model.js` | — | Cover letter on application |
| 2.2 | Candidate(Employee) | Multiple resume versions | 🟡 | Multiple Resume docs allowed | `employee.model.js` documents[] | No version workflow | Uploads possible, not versioned |
| 2.3 | Candidate(Employee) | Tagging skills/experience/keywords | 🟡 | Structured skills[] | `employee.model.js` skills | No free-form tags | Job skillTags are job-level |
| 2.4 | Candidate(Employee) | Advanced search/filtering | 🟢 | buildAdvancedFilter | `employee.service.js`, `CandidatesFilterPanel` | — | Rich filters |
| 2.5 | Candidate(Employee) | Activity history | 🟡 | Notes, activity log, my-profile tab | `activityLog`, `ats/my-profile/page.tsx` | No unified recruiter timeline | Fragmented |
| 2.6 | Candidate(Employee) | Bulk Excel import/export | 🟢 | Import/export endpoints | `candidateExportXlsx.js`, `ats/employees/import` | — | Verified |
| 2.7 | Candidate(Employee) | Compliance: SEVIS, EAD, degree, supervisor | 🟡 | Scalar fields + doc verify + BGV | `employee.model.js`, `placement.backgroundVerification` | No compliance module | Fields persist |
| 2.8 | Candidate(Employee) | Compliance binder PDF/ZIP | 🔴 | exportProfile = plain text email | `employee.controller.js:576-618` | No binder | Not found |
| 2.9 | Candidate(Employee) | Material change logging | 🔴 | Placement status audit only | `placementAudit.service.js` | No material-change model | — |
| 2.10 | Candidate(Employee) | Version history material changes | 🔴 | Absent | — | Entire feature missing | — |
| 3.1 | Recruiter | Dedicated profiles + RBAC | 🟢 | Recruiter CRUD, public profile | `ats/recruiters/*`, `permissions.js` | — | — |
| 3.2 | Recruiter | Activity logs | 🟡 | API + analytics aggregates | `recruiterActivity.service.js`, `ats/analytics` | No recruiter activity UI | Backend exists |
| 3.3 | Recruiter | Metrics: hires, conversion, time-to-fill | 🟡 | Analytics totals/leaderboard | `atsAnalytics.service.js` | No time-to-fill | Conversion only |
| 3.4 | Recruiter | Assign to jobs/departments | 🟡 | assignRecruiterToCandidate | `employee.service.js` | No job/dept assignment | Candidate-level only |
| 3.5 | Recruiter | Workload visibility | 🟡 | Activity leaderboard | `buildRecruiterLeaderboard` | No capacity planner | Counts only |
| 3.6 | Recruiter | Notes on candidate and application | 🟡 | Candidate notes wired | `jobApplication.notes` field | No application notes UI | — |
| 4.1 | Application | Pipeline stages | ⚠️ | atsPipeline.js | `APPLICATION_STATUSES` | +Shortlisted, +Rejected | Interview via schedule |
| 4.2 | Application | Notes, feedback, status | 🟡 | Status per row | `ats/applications/page.tsx` | Notes on candidate only | — |
| 4.3 | Application | Automated notifications | 🟢 | Email on status change | `jobApplication.service.js` notifyByEmail | — | — |
| 4.4 | Application | Audit trail | 🟡 | Platform activity log | `activityLog.js` JOB_APPLICATION_* | No per-app UI | — |
| 4.5 | Application | Bulk-move stages | 🟡 | Single PATCH + offer/placement path | `PATCH /job-applications/:id`, `offer.service.js` | No multi-select batch API | One-at-a-time works |
| 5.1 | Interview | Multi-round scheduling | 🟡 | Multiple meetings | `meeting.model.js` | Types: Video/In-Person/Phone | Not Technical/Panel/HR |
| 5.2 | Interview | Google/Outlook calendar sync | 🔴 | Email invites only | `meeting.service.js`, `outlook.route.js` | No calendar API | — |
| 5.3 | Interview | Built-in video | 🟢 | LiveKit | `livekit.route.js` | — | — |
| 5.4 | Interview | Weighted scoring rubrics | 🔴 | pending/selected/rejected | `meeting.interviewResult` | No rubric | — |
| 5.5 | Interview | Central dashboard | 🟢 | Interviews list/week view | `InterviewsClient.tsx` | Limited scores | — |
| 5.6 | Interview | Automated reminders | 🟢 | meeting.scheduler.js | T-15 reminders | — | — |
| 5.7 | Interview | Recording/transcript | 🟡 | Egress, segments, AI summary | `recording.route.js`, `summaryFinalize.service.js` | Pipeline-dependent | — |
| 5.8 | Interview | Recruiter notes per interview | 🟡 | meeting.notes field | `meeting.model.js` | Limited UI | — |
| 5.9 | Interview | Secure storage/access | 🟢 | interviews.read/manage | `recording.route.js` | — | — |
| 6.1 | Offer | Offer letter templates | 🟢 | Letter generator + defaults | `OfferLetterGeneratorWorkspace.tsx` | — | — |
| 6.2 | Offer | Digital signature (PRD) | 🔴 | Static CEO signature image on PDF (not e-sign) | `ShareOfferModal.tsx` | No e-sign provider | — |
| 6.3 | Offer | Negotiation version control | 🟡 | Under Negotiation status | `offerLetterHash` | No revision chain | Hash dedup only |
| 6.4 | Offer | Placement dashboard | 🟢 | Offers/pre-boarding/onboarding | `ats/offers-placement/page.tsx` | — | — |
| 6.5 | Offer | Auto compliance on role change | 🟡 | Placement audit, role promotion | `placementAudit.service.js` | Manual updates | — |
| 7.1 | Pre-boarding | Auto checklist on accept | 🟡 | Empty preBoardingTasks[] | `offer.service.js`, `placement.model.js` | Manual/SOP tasks | Not auto |
| 7.2 | Pre-boarding | Identity verification | 🟡 | Document verify | `verifyDocument` | No IDV vendor | — |
| 7.3 | Pre-boarding | Payroll setup | 🟡 | CTC on offer | `offer.model.js` | No payroll integration | — |
| 7.4 | Pre-boarding | IT account creation | 🟡 | itAccess[] tracking | `placement.model.js` | Manual checklist | — |
| 7.5 | Pre-boarding | Equipment allocation | 🟡 | assetAllocation[] | `placement.model.js` | Manual tracking | — |
| 7.6 | Pre-boarding | Orientation scheduling | 🟡 | SOP steps | `candidateSopTemplate` | No calendar scheduler | — |
| 7.7 | Pre-boarding | Compliance acknowledgements | 🟡 | SOP checklists | `candidateSop.ts` | Not legal e-ack | — |
| 7.8 | Pre-boarding | 7-day onboarding plan | 🟡 | onboardingTasks[] | `placement.model.js` | Configurable, not 7-day | — |
| 7.9 | Pre-boarding | Onboarding progress dashboard | 🟢 | Pre-boarding + onboarding pages | `ats/pre-boarding`, `ats/onboarding` | — | — |
| 8.1 | Analytics | Detailed metrics | 🟢 | getAtsAnalytics | `ats/analytics/page.tsx` | — | — |
| 8.2 | Analytics | Hiring funnel | 🟢 | applicationFunnel | `atsAnalytics.service.js` | — | — |
| 8.3 | Analytics | Exportable dashboards | 🟡 | Client Excel export | `ats/analytics/page.tsx` | No PDF/scheduled | — |
| 8.4 | Analytics | Custom report builder | 🔴 | Absent | — | — | — |
| AI-1 | AI | Profile from resume parse | 🟡 | Skills + name extract | `resumeSkillsExtract.service.js` | No auto-create profile | Manual form save |
| AI-2 | AI | Call, verify, auto-schedule | 🟡 | Bolna calls stored | `bolnaCandidateVerification.service.js` | No createMeeting | Verify only |
| AI-3 | AI | Interview assessment | 🟡 | AI summaries | `summaryFinalize.service.js` | Not scored rubric | — |
| AI-4 | AI | Intelligent matching | ⚠️ | Rule-based skill fit | `getJobFit`, `matchJobsForCandidate` | Not AI/ML | my-profile UI |
| AI-5 | AI | Predictive insights | 🔴 | Absent | — | — | — |
| AI-6 | AI | Smart notifications | 🟡 | Cron schedulers | `meeting.scheduler.js` | Not LLM nudges | Rule-based |
| AI-7 | AI | Bias detection | 🔴 | Absent | — | — | — |

---

## PART 3 — DETAILED REVIEW BY AREA

### 1. Job Posting Management

**Implemented:** Full CRUD, organisation/skill/location fields, Excel import/export, templates, search/sort, public browse/apply, job stats, share email, bookmarks.

**Partial:** —

**Missing:** Nothing from PRD §1.

**Different:** External job sourcing (Apollo) not in PRD.

**Extra:** External jobs, auto-fetch, Bolna job verification calls, referral links, sales-agent read restrictions.

### 2. Candidate Profile & Compliance

**Implemented:** Profile CRUD, documents, cover letters on applications, skills + AI recommend, advanced filters, bulk Excel, compliance scalar fields, share profile URL, recruiter notes/feedback.

**Partial:** Multiple resume uploads without versioning; skills not free-form tags; fragmented activity; document verify + BGV not full compliance program.

**Missing:** Compliance binder PDF/ZIP; material change logging and version history.

**Different:** UI label "Employees" for candidates.

**Extra:** Share candidate form, referral leads, agent assignment, training SOP, job-fit API.

### 3. Recruiter Profile Management

**Implemented:** CRUD, Excel import/export, public profile, notes, candidate assignment, activity log backend, analytics leaderboard.

**Partial:** No per-recruiter activity UI; no time-to-fill; no job/dept assignment; workload = activity counts only.

**Missing:** Dedicated performance dashboard per PRD.

### 4. Application Tracking Workflow

**Implemented:** Enforced transitions, list/filter, status updates, interview via scheduling, email notifications, my-applications withdraw.

**Partial:** Notes on candidate not application; platform audit log without per-application UI.

**Partial:** Single status PATCH per row + Create Offer → Offered + placement queues. **Missing:** multi-select bulk batch API only.

**Different:** 7 statuses including Shortlisted/Rejected; reopen from Rejected.

**Extra:** Bolna verification fields, referral sync.

### 5. Interview Scheduling & Management

**Implemented:** Meeting CRUD, LiveKit video, reminders, recordings, export, move-to-preboarding, internal transfer.

**Partial:** Multi-meeting not typed rounds; transcripts/summaries pipeline-dependent.

**Missing:** Calendar sync, weighted rubrics.

**Extra:** Waiting room, panel agents, meeting series.

### 6. Offer & Placement Management

**Implemented:** Offer CRUD, letter generator, AI role enhance, PDF email share, placement queues, audit, auto-expire.

**Partial:** Negotiation = status only; compliance updates manual.

**Missing:** E-signature.

**Extra:** Bulk delete offers, placement sub-statuses (Deferred/Cancelled).

### 7. Pre-Boarding & Onboarding

**Implemented:** Integrated pipeline queues, BGV/assets/IT tracking, SOP system, reminders, training assignment.

**Partial:** Empty checklist on accept; manual IDV/payroll/IT/equipment; no vendor integrations.

**Missing:** Automated provisioning integrations.

**Extra:** Offboarding SOP, role promotion scheduler.

### 8. Analytics & Reporting

**Implemented:** Full analytics dashboard, funnel, drill-down, Excel export, dashboard widgets.

**Partial:** Export spreadsheet only.

**Missing:** Custom report builder.

**Extra:** Chat assistant interview analytics, referral stats.

### 9. AI Integration

**Implemented:** Resume skill extract, skill recommend, Bolna calls, offer enhance, meeting summaries, Pinecone embeddings (chatbot).

**Partial:** AI-1 through AI-4 and AI-6 as described in matrix.

**Missing:** Predictive insights, bias detection.

---

## PART 4 — EXTRA ATS FUNCTIONALITY (summary)

Short index. Full classification, evidence, and product-value notes are in **Part 13**.

| Extra | Where | What | Why outside PRD |
|-------|-------|------|-----------------|
| External jobs + Apollo | `externalJob.route.js`, `ats/external-jobs` | Search/save/auto-fetch/enrich HR contacts | Internal jobs only in PRD |
| Referral CRM | `referralLeads.service.js`, `ats/referral-leads` | Attribution, HMAC links, sales agents | Not in PRD |
| Share candidate form | `ats/share-candidate-form`, `/candidate-onboard` | Token onboarding | Acquisition channel |
| Candidate / public portals | `ats/browse-jobs`, `ats/my-applications`, `/public-job` | Self-service apply + my-apps | Recruiter-centric PRD |
| Public recruiter profiles | `/public-recruiter/[id]` | External recruiter page | Not in PRD |
| Bolna job verification | `jobVerificationCall.scheduler.js` | Verify new postings | PRD AI is candidate-focused |
| Extra pipeline stages | `atsPipeline.js` | Shortlisted, Rejected reopen, Deferred/Cancelled | PRD has a shorter funnel |
| LiveKit waiting room | `livekit.route.js` | Host admit/deny | Beyond “built-in video” |
| Internal transfer | `POST /meetings/:id/internal-transfer` | Internal mobility | Not in PRD |
| Candidate SOP | `candidateSopTemplate.route.js` | Configurable checklists + reminders | Broader than PRD 7-day plan |
| Offboarding SOP | `offboardingSop.route.js` | Post-employment | Not in PRD |
| Job bookmarks | `job.route.js` | Saved jobs + notes | Not in PRD |
| Click-to-call | Employees list + Plivo/Twilio | Softphone from ATS rows | Not in PRD |
| HRMS-on-ATS | week-off / shift / attendance / joining | Workforce ops on candidate records | PRD is hiring-only |
| Chat assistant ATS | `chatAssistant.service.js` | NL queries with page context | Not in PRD |
| Training/LMS in ATS | sidebar Courses + SOP assign | Training assignment from hiring | Not in PRD |

---

## PART 5 — PRD GAPS (PRIORITISED)

| Priority | Requirement | Current state | Required work | Dependencies |
|----------|-------------|---------------|---------------|--------------|
| P0 | Compliance binder (2.8) | Plain-text email | PDF/ZIP assembly + UI | S3, templates |
| P0 | Digital signature (6.2) | Email PDF | E-sign provider + webhooks | Vendor |
| P0 | Bulk application move (4.5) | Single PATCH | Batch API + UI | atsPipeline guards |
| P1 | AI auto-schedule (AI-2) | Bolna verify only | Webhook → createMeeting | Bolna disposition |
| P1 | Interview rubrics (5.4) | selected/rejected | Rubric model + UI | Meeting model |
| P1 | Material change log (2.9-2.10) | Placement audit | MaterialChange model | Compliance |
| P1 | Calendar sync (5.2) | Email only | Google/Outlook OAuth | Credentials |
| P1 | Application notes UI (3.6) | Field exists | Applications page editor | — |
| P2 | Auto pre-boarding checklist (7.1) | Empty tasks | Template on accept | SOP config |
| P2 | Time-to-fill (3.3) | Not computed | Analytics aggregation | Timestamps |
| P2 | Recruiter job assignment (3.4) | Candidate only | Job↔recruiter model | — |
| P2 | Custom report builder (8.4) | Absent | Builder UI + API | Analytics |
| P2 | Full AI profile (AI-1) | Skills only | Full field mapping | OpenAI |
| P3 | Predictive AI (AI-5) | Historical only | Forecast service | Data volume |
| P3 | Bias detection (AI-7) | Absent | NLP on feedback | Privacy review |

---

## PART 6 — DO NOT COUNT AS FULLY IMPLEMENTED

| Item | Reason |
|------|--------|
| Offer CEO signature image | Static print asset, not e-sign |
| getJobFit / matching jobs | Deterministic skill overlap, not AI |
| Resume extract | Skills + name; user still fills form |
| Bolna verification | No createMeeting after call |
| exportProfile | Plain-text email, not binder |
| JobApplication.notes | No UI on applications page |
| Recruiter activity API | No recruiter profile activity tab |
| Outlook route | Mail only, not calendar |
| interviewResult | Tri-state, not rubric |
| preBoardingTasks on accept | Created empty |
| conversionRate | Historical ratio, not forecast |
| Meeting summaries | Not hiring assessment scores |
| Pinecone embeddings | Chatbot RAG, not ATS matching |

---

## PART 7 — DUPLICATE / OVERLAPPING FUNCTIONALITY

| Overlap | Risk |
|---------|------|
| Candidates vs Employees naming | Permission/key confusion |
| Notes on candidate vs application vs meeting | Inconsistent recording |
| activityLog vs RecruiterActivityLog | Duplicate audit sources |
| preBoardingTasks vs SOP checklists | Two checklist systems |
| Resume vs CV/Resume doc types | Duplicate semantics |
| Bolna + Twilio + Plivo | Telephony complexity |
| getJobFit vs Pinecone | Two matching approaches |
| Offer embedded placement vs Placement collection | Sync burden |
| Four workflow enums in atsPipeline | Transition consistency |

---

## PART 8 — ACTUAL ATS WORKFLOW

```
Job Created (Draft → Active)
  → Candidate Added (import / form / public apply / share-form)
  → Application (Applied)
  → Screening (manual)
  → Interview Scheduled (Meeting + LiveKit) → status Interview
  → Interview outcome (selected/rejected)
  → Shortlisted (optional)
  → Offer (Draft → Sent → Negotiation → Accepted)
  → Placement (Pending, empty preBoardingTasks)
  → Pre-Boarding (BGV, assets, IT, SOP)
  → Onboarding (onboardingTasks)
  → Joined → Application Hired

Branches: Rejected (reopen allowed); offer reject → placement cancel;
Bolna call after apply (does NOT auto-schedule interview)
```

---

## PART 9 — DATA / ARCHITECTURE COVERAGE

| Entity | Model | Gap |
|--------|-------|-----|
| Job | Job, JobTemplate, ExternalJob | No recruiter-per-job |
| Candidate | Employee (candidates) | No tags, no material history |
| Application | JobApplication | notes unused in UI |
| Interview | Meeting, Recording, Summary | No rubric scores |
| Offer | Offer | No revision chain |
| Placement | Placement | Empty tasks on create |
| Compliance | Fields + BGV | No binder model |
| AI matching | skills[] only | Not ML |
| Reporting | Aggregations | No ReportDefinition |

---

## PART 10 — SECURITY / ACCESS CONTROL

- RBAC via `permissions.js` matrix (`ats.jobs`, `ats.candidates`, `ats.interviews`, `ats.offers`, etc.).
- Document routes gated by `pre-boarding.*` / `candidates.manage`.
- Recordings/transcripts require `interviews.read` / `meetings.record`.
- Public profiles token-gated (`public-employee`, `public-recruiter`).
- Placement audit requires `placement.audit`.
- SEVIS/EAD stored as plain strings — field-level encryption not verified in code.
- Could not verify retention policies for recordings from code alone.

---

## PART 11 — INTEGRATION COVERAGE

| Integration | PRD | Exists | E2E | Gap |
|-------------|-----|--------|-----|-----|
| Excel jobs/candidates | Yes | Yes | Yes | — |
| Google Calendar | Yes | No | No | Not implemented |
| Outlook Calendar | Yes | No | No | Mail only |
| LiveKit video | Yes | Yes | Yes | — |
| Bolna telephony | AI-2 | Yes | Partial | No auto-schedule |
| Email notifications | Yes | Yes | Yes | — |
| Digital signature | Yes | No | No | — |
| PDF offer letters | Partial | Yes | Yes | — |
| ZIP compliance binder | Yes | No | No | — |
| OpenAI | AI | Yes | Partial | Not all AI PRD items |
| Transcripts | Yes | Partial | Partial | Pipeline-dependent |
| Apollo external jobs | Extra | Yes | Yes | — |

---

## PART 12 — DIRECTION A SCORECARD (PRD → product)

| Area | Reqs | 🟢 | 🟡 | 🔴 | 🟣 Extra |
|------|:----:|:--:|:--:|:--:|:--------:|
| 1. Job Posting | 5 | 5 | 0 | 0 | see Part 13 |
| 2. Candidate & Compliance | 10 | 3 | 5 | 2 | see Part 13 |
| 3. Recruiter | 6 | 1 | 5 | 0 | see Part 13 |
| 4. Application | 5 | 1 | 2 | 1 | see Part 13 |
| 5. Interview | 9 | 4 | 3 | 2 | see Part 13 |
| 6. Offer & Placement | 5 | 2 | 2 | 1 | see Part 13 |
| 7. Pre-boarding | 9 | 1 | 7 | 0 | see Part 13 |
| 8. Analytics | 4 | 2 | 1 | 1 | see Part 13 |
| 9. AI | 7 | 0 | 5 | 2 | see Part 13 |
| **TOTAL** | **60** | **19** | **29** | **10** | **32** |

(2 requirements are ⚠️ implemented differently and are included in the 60; they are not in the 🟢/🟡/🔴 columns. See matrix rows 4.1 and AI-4.)

### Overall PRD coverage: **31.7% strict** / **58.3% weighted**

### Strongest: Job posting, video interviews, offer/placement queues, analytics funnel.

### Weakest: AI (0/7 full), compliance binder, e-sign, calendar sync, bulk moves, custom reports.

### Biggest production gaps: No e-sign; Bolna doesn't schedule interviews; no bulk application moves; no time-to-fill.

---

## PART 13 — DIRECTION B: ACTUAL PRODUCT → PRD

This section was produced from an independent inventory of ATS pages, APIs, models, schedulers, queues, permissions, and integrations. It does **not** start from the PRD.

### Actual ATS surface inventoried

**Frontend ATS routes (`nav.tsx` + `app/.../ats/`):** Jobs, Applications, External Jobs, Employees, Referral leads, Share candidate form, Browse Jobs, My Applications, Courses, Recruiters, Interviews, Offers & Placement, Pre-boarding, Onboarding, Analytics.

**Public / unauthenticated:** `/public-job`, `/public-job/[jobId]`, `/public-recruiter/[id]`, `/public-employee/[id]`, `/candidate-onboard`, `/join/room`.

**Settings that exist only because ATS grew:** job templates, candidate SOP, Bolna voice agent, agent pairing, offboarding SOP.

**Backend route files (ATS-specific):** `job.route.js`, `employee.route.js` (`/candidates` + `/employees`), `jobApplication.route.js`, `offer.route.js`, `placement.route.js`, `meeting.route.js`, `externalJob.route.js`, `atsAnalytics.route.js`, `recruiterActivity.route.js`, `recruiterExcel.route.js`, `recruiterNote.route.js`, `candidateSopTemplate.route.js`, `offboardingSop.route.js`, `public.route.js`, `bolna.route.js`, `livekit.route.js`, `recording.route.js`.

**Schedulers that run ATS work:** `employee.scheduler`, `applicationVerificationCall.scheduler`, `jobVerificationCall.scheduler`, `callRecordSync.scheduler`, `externalJobAutoFetch.scheduler`, `meeting.scheduler`, `recording.scheduler`, `recordingDiscovery.scheduler`, `embeddingSync.scheduler`, `salesAgentCacheReconciler.scheduler`.

**Queue:** `summaryQueue` / `summaryWorker` (interview/meeting AI finalize).

### Extra-functionality classification

**🟣 EXTRA — FULLY IMPLEMENTED (27)**  
Working product capabilities the PRD does not describe (or only describes a much smaller version of).

**🟣 EXTRA — PARTIALLY IMPLEMENTED (4)**  
Built beyond the PRD, but incomplete, backend-only, or used for a different purpose than the product surface implies.

**🟣 EXTRA — UI/PLACEHOLDER (1)**  
Exposed or gated in code, but the implementation is a stub.

Tiny helpers, indexes, and generic buttons are excluded.

---

## PART 13A — EXTRA FUNCTIONALITY MATRIX

| # | Actual ATS Functionality | PRD Coverage | Status | Evidence | Description | Product Value |
|---|--------------------------|--------------|--------|----------|-------------|---------------|
| 1 | External job aggregation (search, save, auto-fetch) | Not mentioned in PRD | Fully implemented | `externalJob.route.js`, `externalJobAutoFetch.scheduler.js`, `ats/external-jobs` | Search external listings, persist saved jobs, scheduled sync | Recruiters source beyond internal postings |
| 2 | Apollo HR-contact enrichment | Not mentioned in PRD | Fully implemented | `apollo.service.js`, `/external-jobs/hr-contacts*`, Contacts tab | People search + webhook enrich for hiring contacts | Outbound sourcing on external jobs |
| 3 | Referral leads CRM | Not mentioned in PRD | Fully implemented | `referralLeads.service.js`, `ats/referral-leads`, HMAC `POST /referral-link` | Leads board, stats, export, lifecycle pills | Sales/referral channel with pipeline |
| 4 | Sales-agent attribution (assign / change / revoke / override / history) | Not mentioned in PRD | Fully implemented | `salesAgentAttribution.service.js`, attribution modals, `referralAttribution.model.js` | Locked first-touch attribution with admin override audit | Commission / ownership integrity |
| 5 | Tokenized share-candidate onboarding form | Not mentioned in PRD | Fully implemented | `ats/share-candidate-form`, `/candidate-onboard`, `candidate.onboardingShare` | Email/Excel invites → 24h token form | Candidate acquisition without recruiter data entry |
| 6 | Public job board + unauthenticated apply | Related but materially beyond PRD | Fully implemented | `/public-job`, `POST /public/jobs/:id/apply`, `public.route.js` | Public listing, resume/docs/cover, referral `ref=` | External careers site, not just internal CRUD |
| 7 | Candidate self-service portal | Not mentioned in PRD | Fully implemented | `ats/browse-jobs`, `ats/my-applications`, `ats/my-profile`, `GET /candidates/me`, `GET /me/matching-jobs` | Browse/apply, withdraw, self-profile, skill-fit matches | Candidate-facing ATS, not recruiter-only |
| 8 | Public recruiter profiles | Related but materially beyond PRD | Fully implemented | `/public-recruiter/[id]`, `publicRecruiter` API, `RecruiterPublicProfileView` | Shareable recruiter page + preview | Employer-brand / recruiter marketing |
| 9 | Configurable candidate SOP + reminders + training assign | Related but materially beyond PRD | Fully implemented | `candidateSopTemplate.route.js`, `sopChecklist.service.js`, `settings/candidates/sop` | Template CRUD; checkers for profile/shift/week-off/holiday/agent/training; reminder dispatch | Operational onboarding beyond a static 7-day list |
| 10 | Offboarding SOP | Not mentioned in PRD | Fully implemented | `offboardingSop.route.js`, `offboardingActions.service.js`, `settings/offboarding/sop` | Deactivate email, reassign tasks, disable org access | End-of-employment workflow the PRD never scoped |
| 11 | LiveKit waiting room / lobby | Related but materially beyond PRD | Fully implemented | `livekit.route.js` admit/remove, `/join/room` | Host admit/deny before interview room | Production video control, not “video exists” |
| 12 | Post-interview internal transfer | Not mentioned in PRD | Fully implemented | `POST /meetings/:id/internal-transfer`, `employeeTransfer.model.js`, `InterviewsClient.tsx` | Move existing employee after interview | Internal mobility product |
| 13 | Click-to-call from ATS employee rows | Not mentioned in PRD | Fully implemented | `CallNowButton.tsx`, Plivo/Twilio public webhooks, `calls.*` perms | Softphone overlay from candidate list | Recruiter telephony inside ATS |
| 14 | Bolna job-posting verification calls | Not mentioned in PRD | Fully implemented | `jobVerificationCall.scheduler.js`, Job preview initiate call | Automated voice verify of new jobs | Quality control on postings; PRD AI is candidate-only |
| 15 | Job bookmarks with notes | Not mentioned in PRD | Fully implemented | `GET/POST /jobs/:id/bookmarks`, Jobs page | Saved jobs + public/private notes | Recruiter shortlist of jobs |
| 16 | Training / LMS inside ATS nav | Not mentioned in PRD | Fully implemented | sidebar Courses, SOP `AssignTrainingCourseSopModal`, `placement.trainingModuleId` | Assign courses from hiring records | Hiring → learning handoff |
| 17 | Sales-agent-only dashboard | Not mentioned in PRD | Fully implemented | `SalesAgentDashboard.tsx` on `/dashboard` | Referral-focused home for sales-agent roles | Role-specific ATS, not one recruiter dashboard |
| 18 | Extra lifecycle stages (Shortlisted, Rejected reopen, Deferred/Cancelled) | Related but materially beyond PRD | Fully implemented | `atsPipeline.js` APPLICATION/PLACEMENT statuses, applications reopen UI | 7 application statuses; placement off-ramps | Real funnel is richer than PRD’s 5-stage sketch |
| 19 | HRMS operations on ATS employees | Not mentioned in PRD | Fully implemented | week-off, assign-shift, attendance overlay, joining/resign dates, `employee.scheduler` | Workforce ops on the same “Employees” list | ATS people records are also HR records |
| 20 | Chat assistant with ATS page context | Not mentioned in PRD | Fully implemented | `FloatingChatbot`, `setChatUiContext` on employees, `chatAssistant.service.js` | NL queries over ATS entities | In-product copilot the PRD does not mention |
| 21 | Document request / verify + salary slips | Related but materially beyond PRD | Fully implemented | `verifyDocument`, `requestDocumentFromCandidate`, salary-slip routes, `PreBoardingDocumentsModal` | Recruiter requests docs; candidate fulfills | Working compliance ops without the PRD binder |
| 22 | WhatsApp / email share for jobs and profiles | Related but materially beyond PRD | Fully implemented | `JobShareModal`, `CandidateShareModal`, `shareJobByEmail`, `shareCandidateProfile` | Copy URL, WhatsApp, email | Distribution channel |
| 23 | Recruiter Excel import/export | Related but materially beyond PRD | Fully implemented | `recruiterExcel.route.js`, recruiters page | Bulk recruiter roster | Ops scale; PRD only described profiles |
| 24 | Agent pairing settings | Related but materially beyond PRD | Fully implemented | `/settings/agents`, `assign-agent`, bulk assign | Pair candidates/students to agents | Ownership model beyond “assign recruiter to job” |
| 25 | Company work-email assignment | Not mentioned in PRD | Fully implemented | `/candidates/company-email-*`, `company-email.*` perms | Roster of assigned work emails | IT/HR provisioning the PRD listed as a gap |
| 26 | Candidate feedback / star ratings | Related but materially beyond PRD | Fully implemented | `POST /:id/feedback`, Feedback modal, star input | Structured rating on people, not only notes | Recruiter scoring without interview rubrics |
| 27 | Placement status audit trail | Partially described in PRD | Backend only | `GET /placements/:id/audit`, `placementAudit.service.js` | Status-change audit exists; **no ATS UI found** | Partial answer to PRD 6.5 / 2.9 |
| 28 | Recruiter activity log product | Partially described in PRD | Partially implemented | `recruiterActivity.route.js`, analytics leaderboard; no per-recruiter activity tab | Backend + aggregates; missing dedicated UI | PRD 3.2/3.5 still incomplete |
| 29 | Vector embeddings of employees/jobs | Related but materially beyond PRD | Partially implemented | `embeddingSync.scheduler.js`, Pinecone/Qdrant | Indexed for chatbot RAG; **job-fit is still skill overlap** | Extra infra, not the PRD “intelligent matching” |
| 30 | Interview transcripts / AI summaries as ATS artifacts | Partially described in PRD | Partially implemented | `recording.route.js`, `summaryQueue`, `RecordingsModal`; Communication owns most UX | Pipeline exists; ATS interview UI does not present a full transcript product | Extra recording stack beyond PRD 5.7 |
| 31 | Interview → pre-boarding handoff + meeting series + interview Excel | Related but materially beyond PRD | Fully implemented | `POST /meetings/:id/move-to-preboarding`, `meeting.scheduler` series, `exportInterviewsExcel` | Selected outcome can create placement path; series + export | Workflow glue the PRD does not specify |
| 32 | Public-apply captcha gate | Not mentioned in PRD | UI only | `public.route.js` captchaGate; `CAPTCHA_REQUIRED` checks token **presence** only | Anti-abuse toggle with TODO provider | Placeholder, not a shipping captcha product |

Row 31 is fully implemented extra workflow (not a PRD requirement). Row 32 is the only placeholder.

---

## PART 13B — FUNCTIONALITY SIGNIFICANTLY BEYOND THE PRD

Verified in repo. Not claimed unless wired.

| Area the prompt asked to check | Verdict | Evidence |
|-------------------------------|---------|----------|
| Additional candidate lifecycle stages | **Yes** | Application: Applied/Screening/Interview/**Shortlisted**/Offered/Hired/**Rejected**. Placement: Pending/Onboarding/Joined/**Deferred**/**Cancelled**. Referral: pending→applied→interview→offer→preboarding→hired→joined→employee (+ resigned/rejected/withdrawn/job_removed) |
| Preboarding workflows | **Yes, beyond PRD** | Dedicated `/ats/pre-boarding` queue; BGV/assets/IT; document request/verify; SOP; `preboarding.override` |
| Onboarding workflows | **Yes, beyond PRD** | Dedicated `/ats/onboarding`; SOP templates; training assign; joining reminders |
| Compliance automation | **Partial / different** | Document verify + BGV fields + SOP checkers. **No** binder PDF/ZIP, **no** material-change version history |
| Referral functionality + attribution | **Yes** | Full CRM + HMAC links + sales-agent ownership + override audit |
| Candidate sourcing / external jobs / aggregation | **Yes** | External Jobs module + auto-fetch + Apollo |
| Job sharing | **Yes** | Email, WhatsApp, public URL, personal referral link |
| Saved jobs | **Yes** | Internal bookmarks + external saved jobs |
| Candidate/job matching | **Yes, not AI** | `GET /me/matching-jobs`, `GET /:id/job-fit` — skill overlap |
| Bulk operations | **Yes, except PRD 4.5** | Jobs delete/import/export; employee import/export/week-off/shift; offer bulk delete; share-form Excel; **no bulk application stage move** |
| Advanced filters | **Yes** | Jobs, employees, interviews, referral leads, external jobs, applications |
| Audit / history | **Partial extra** | Platform activity log + referral attribution history + placement audit API (no placement audit UI) |
| Recruiter workload / dashboards / KPIs | **Partial extra** | `/ats/analytics` funnel, recruiter leaderboard, dashboard widgets; **no time-to-fill**, **no capacity planner** |
| Notifications / reminders | **Yes** | Meeting T-15, SOP reminders, joining reminders, status emails, notification pref groups |
| Automated workflows | **Yes** | Offer auto-expire, resign auto-deactivate, Bolna job/application verification, external auto-fetch, role promotion hooks |
| Document management | **Yes** | Request/verify/upload/delete; salary slips; S3 |
| Placement / offer / interview workflows | **Yes, richer than PRD** | Letter generator, compensation gate, LiveKit, recordings, internal transfer |
| Scoring systems | **Partial** | Star feedback + interviewResult tri-state; **no weighted rubrics** |
| AI workflows / agents / calling | **Yes extra + PRD-partial** | Bolna agents, job verification calls, resume skills, offer enhance, meeting summaries. **No** auto-schedule, **no** bias detection, **no** predictive AI |
| Transcript processing | **Partial** | Egress → segments → BullMQ finalize |
| Automated scheduling | **No as PRD AI-2** | Reminders and auto-end exist; Bolna does **not** `createMeeting` |
| Excel import/export | **Yes, broader than PRD** | Jobs, candidates, recruiters, interviews, referral leads, analytics |
| Role/permission systems | **Yes extra** | Granular `ats.*` matrix; dual employees vs candidates; sales-agent attribution perms; `share-candidate-form.*`; `external-jobs.*`; `candidate-sop.*` |
| Candidate / recruiter / public portals | **Yes** | See rows 6–8 |
| Custom report builder | **No** | Confirmed absent (PRD 8.4) |
| E-signature | **No** | Confirmed absent (PRD 6.2) |
| Calendar sync | **No** | Outlook is mail, not calendar (PRD 5.2) |
| Kanban pipeline page | **No** | `ats-pipeline-list.module.css` exists; no kanban `page.tsx` |

---

## PART 14 — PRD EVOLUTION / PRODUCT DRIFT

The original PRD describes a **recruiter-operated hiring ATS**: jobs, candidate files, applications, interviews, offers, a 7-day pre-board, analytics, and a set of AI aspirations.

The shipping product is a **hiring + referral + sourcing + candidate-portal + workforce-adjacent system**. The PRD is outdated as a description of what Dharwin ATS is.

### 1. PRD features no longer represented accurately

- **Application pipeline:** PRD’s five-stage sketch is not what `atsPipeline.js` enforces. Shortlisted, Rejected, and reopen rules are first-class.
- **“Candidate”:** Product language is **Employees** (`/ats/employees`), with a dual `candidates.*` / `employees.*` permission row. PRD never names that split.
- **Pre-boarding as a checklist that appears on offer accept:** Code creates empty `preBoardingTasks[]`. The live product is a **queue + SOP + document requests**, not the PRD auto-checklist.
- **AI matching / AI calling / AI assessment:** Product has rule-based fit, Bolna verification (no auto-schedule), and meeting summaries. The PRD’s wording oversells what shipped.
- **Compliance binder / material-change history:** PRD treats these as core; they are absent. Adjacent document verify exists instead.
- **Recruiter assigned to jobs/departments:** Product assigns recruiters and sales agents to **people**, not to jobs.

### 2. Features that evolved beyond the PRD

- Interviews: LiveKit **waiting room**, recordings, series, Excel export, move-to-preboarding, internal transfer.
- Offers: letter workspace, AI role enhance, compensation gate, bulk delete, auto-expire.
- Analytics: drill-down + recruiter leaderboard + dashboard widgets (still no custom report builder).
- Pre-board/onboard: split into two queues plus SOP automation.

### 3. Features added after the PRD was written (no corresponding requirement)

- External jobs + Apollo + auto-fetch
- Referral leads CRM + HMAC referral links + sales-agent attribution
- Share-candidate-form / `/candidate-onboard`
- Public job board and candidate self-service
- Public recruiter profiles
- Offboarding SOP
- Click-to-call (Plivo/Twilio) from ATS rows
- Bolna **job** verification (distinct from candidate AI-2)
- Chat assistant with ATS context
- Courses/LMS in the ATS sidebar
- Sales-agent dashboard
- HRMS operations on ATS employee records
- Company work-email assignment
- Granular ATS RBAC expansion (`external-jobs.*`, `share-candidate-form.*`, `candidate-sop.*`, sales-agent attribution keys)

### 4. Terminology drift

| PRD term | Product term |
|----------|--------------|
| Candidate | Employee (`/ats/employees`); “candidate” remains in APIs and some perms |
| Application stages (5) | 7 statuses including Shortlisted/Rejected |
| Interview rounds (Technical/HR/Panel) | Meeting types Video / In-Person / Phone |
| Pre-boarding checklist | Pre-boarding **queue** + Candidate SOP |
| Digital signature | Email PDF + static CEO image |
| Intelligent matching | `getJobFit` skill overlap |
| Recruiter assigned to job | Recruiter/agent assigned to person; sales agent on referral |

### 5. Workflows materially more sophisticated than the PRD

- Referral: mint link → claim on apply/register → pipeline status sync → sales-agent lock → admin override with reason → Excel export.
- External jobs: search → save → optional auto-fetch cron → Apollo enrich → HR contacts.
- Interview: schedule → lobby → LiveKit record → transcript/summary queue → result → transfer or pre-board.
- Offer accept → Placement create/resurrect → compensation/joining sync → pre-board/onboard queues → Joined → referral `hire.joined`.

### 6. Product areas with no corresponding PRD requirement

External jobs, referral CRM, candidate portal, public recruiter pages, share-form, offboarding SOP, telephony, job-verification calls, chat copilot, LMS-in-ATS, sales-agent dashboard, HRMS-on-ATS, company work email.

**Do not remove extra functionality because it is absent from the PRD.** It is the current product. The PRD should be rewritten to include it.

---

## PART 15 — FINAL TWO-WAY SCORECARD

### A. PRD coverage — what percentage of the PRD is implemented?

| Metric | Count / score |
|--------|----------------|
| Total PRD requirements | **60** |
| Fully implemented | **19** |
| Partially implemented | **29** |
| Implemented differently | **2** (pipeline stages; “AI” matching) |
| Missing | **10** |
| UI-only / backend-only as *primary* PRD status | **0** |
| **Strict coverage** | **31.7%** (19 ÷ 60) |
| **Weighted coverage** | **58.3%** (🟢=1, 🟡=0.5, ⚠️=0.75) |

Missing (unchanged from Direction A): 2.8 binder, 2.9–2.10 material-change history, 4.5 bulk application move, 5.2 calendar sync, 5.4 weighted rubrics, 6.2 e-sign, 8.4 custom reports, AI-5 predictive, AI-7 bias detection.

### B. Product expansion — what has the ATS built beyond the PRD?

| Metric | Count |
|--------|------:|
| Meaningful extra features | **32** |
| Extra — fully implemented | **27** |
| Extra — partially implemented | **4** (includes 1 backend-only: placement audit) |
| Extra — UI / placeholder | **1** (public-apply captcha stub) |

---

### What the PRD says the ATS should be

A recruiter ATS: internal jobs, candidate files with compliance binder, five-stage applications, scored interviews with calendar sync, e-signed offers, auto 7-day pre-board, custom reports, and AI that parses profiles, calls candidates, auto-schedules, matches, predicts, and detects bias.

### What the ATS actually is today

A **hiring + sourcing + referral + candidate-portal** product with LiveKit interviews, offer/placement queues, SOP-driven onboarding, ATS analytics, and several AI/telephony add-ons. People are “Employees.” Matching is skill overlap. Bolna verifies; it does not schedule. Compliance is document verify + BGV fields, not a binder.

### What the ATS has that the PRD does not describe

External jobs/Apollo, referral CRM and sales-agent attribution, share-candidate-form, public job board, candidate self-service, public recruiter profiles, candidate SOP + offboarding SOP, waiting room, internal transfer, click-to-call, job-verification calls, job bookmarks, LMS in ATS, sales-agent dashboard, HRMS-on-ATS, chat assistant, WhatsApp sharing, recruiter Excel, agent pairing, company work emails, extra pipeline stages.

### What the PRD describes that the ATS does not yet have

Compliance binder PDF/ZIP; material-change version history; Google/Outlook **calendar** sync; weighted interview rubrics; digital signatures; bulk application stage moves; custom report builder; AI auto-schedule; predictive insights; bias detection; true resume-to-full-profile parse; time-to-fill; recruiter-to-job assignment.

### Where the PRD is now outdated

Pipeline shape, candidate vs employee naming, pre-board as auto-checklist, AI claims, compliance-as-binder, recruiter-only scope. The live ATS is a multi-channel hiring system; the PRD is still a module list from an earlier product.

### What should be added to a new / current PRD

1. External Jobs (search, save, auto-fetch, Apollo contacts).  
2. Referral Leads (HMAC links, attribution lock, sales agents, export).  
3. Candidate portal (public jobs, my applications, my profile, matching jobs).  
4. Share-candidate onboarding tokens.  
5. Public recruiter profiles.  
6. Candidate SOP + offboarding SOP.  
7. Actual pipeline enums (application, offer, placement, referral).  
8. LiveKit lobby/recording/transcript pipeline as specified.  
9. Telephony (click-to-call + Bolna job/application verification) with the auto-schedule gap explicit.  
10. RBAC matrix as shipped (`employees.*`, `external-jobs.*`, `share-candidate-form.*`, `candidate-sop.*`, attribution keys).  
11. Keep unmet original items as an explicit backlog: binder, e-sign, calendar sync, rubrics, bulk-move, custom reports, predictive/bias AI.

---

## PART 16 — DIRECTION B METHOD NOTES

- Inventory sources: frontend `ats/**` pages, sidebar `nav.tsx`, public auth-layout routes, backend `src/routes/v1` ATS routers, models, `*.scheduler.js`, `summaryQueue`, `permissions.js`, `activityLog.js`.
- Completeness requires a wired UI **or** a scheduler/API that a product user can trigger. Schema-only fields were not counted as extra features.
- Placement audit and recruiter activity APIs are extra *capabilities* but not extra *products* until they have UI (counted partial / backend-only).
- Runtime behaviour still depends on `.env` (Bolna, LiveKit, Redis, Apollo). Those integrations are coded; credentials were not exercised in this review.

---

## APPENDIX — KEY FILES

**Backend:** `src/constants/atsPipeline.js`, `src/routes/v1/job.route.js`, `employee.route.js`, `jobApplication.route.js`, `meeting.route.js`, `offer.route.js`, `placement.route.js`, `atsAnalytics.route.js`, `bolna.route.js`, `externalJob.route.js`, `candidateSopTemplate.route.js`, `offboardingSop.route.js`, `recruiterActivity.route.js`, `recruiterExcel.route.js`, `public.route.js`, `livekit.route.js`

**Frontend:** `app/(components)/(contentlayout)/ats/` (jobs, applications, external-jobs, employees, referral-leads, share-candidate-form, browse-jobs, my-applications, my-profile, recruiters, interviews, offers-placement, pre-boarding, onboarding, analytics), `shared/layout-components/sidebar/nav.tsx`, `shared/lib/api/{jobs,employees,jobApplications,meetings,offers,placements,atsAnalytics,bolna,external-jobs,referralLeads,candidateSop}.ts`

---

*End of two-way audit. Runtime behaviour may differ based on .env, schedulers, and external credentials — not executed during this review.*
