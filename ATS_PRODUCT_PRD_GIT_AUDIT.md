<style>
table { display: block; width: max-content; max-width: 100%; overflow-x: auto; }
</style>

# ATS / PRODUCT PRD & GIT AUDIT

**Audit date:** 7 September 2026  
**PRD source:** `C:\Users\INTEL\Downloads\Dharwin Business Integrated ATS_Updated.pdf` (22 pages, 4 modules)  
**Repositories audited:** `uat.dharwin.backend`, `uat.dharwin.frontend`  
**Method:** Read-only. PRD decomposition → full codebase trace (routes, services, models, UI) → Git history (`git log`, `--follow`, `--diff-filter=D`). No runtime testing. No code changes.  
**Prior work reused:** `ATS-PRD-AUDIT.md` (Module 1 deep traceability, verified independently for this audit).

---

## 1. Executive Summary

Dharwin is a **four-module integrated platform** (ATS, Communication, Training, Projects) built on **Next.js + Express + MongoDB** — materially different from the PRD’s proposed **NestJS + Prisma + PostgreSQL** stack. The shipping product is **significantly broader** than the PRD in sourcing (external jobs, referral CRM), candidate self-service, telephony, and HRMS-adjacent workforce features, while **under-delivering** on compliance binders, e-signatures, calendar sync, interview rubrics, custom reporting, enterprise comm security (SSO/MFA/DLP), PM deliverables, and several AI aspirations.

### Combined PRD coverage (all 4 modules)

| Metric | Value |
|--------|------:|
| Total PRD requirements audited | **155** |
| 🟢 Fully implemented | **51** (32.9%) |
| 🟡 Partially implemented | **70** (45.2%) |
| ⚠️ Implemented differently | **5** (3.2%) |
| 🟠 UI / placeholder only | **2** (1.3%) |
| 🔵 Backend only | **1** (0.6%) |
| 🔴 Not implemented | **26** (16.8%) |
| ⚫ Historically implemented / removed | **6** tracked features |
| **Strict PRD coverage** | **32.9%** (51 ÷ 155; only 🟢 counts) |
| **Weighted PRD coverage** | **58.2%** (🟢=1.0, 🟡=0.5, ⚠️=0.75, 🟠/🔵=0.25, 🔴=0) |

**How the percentage is calculated:** Each requirement receives exactly one primary status. UI-only and backend-only are **not** counted as fully implemented. Extra product functionality does **not** increase the score.

### Product expansion (beyond PRD)

| Metric | Count |
|--------|------:|
| Meaningful extra features identified | **~72** across modules |
| Fully implemented extras | **~58** |
| Partial extras | **~13** |
| UI/placeholder extras | **1** (public-apply captcha stub) |

### Headline answers

| Question | Answer |
|----------|--------|
| What did the PRD ask us to build? | End-to-end ATS + unified comm + training LMS + project kanban with AI across all layers |
| What have we actually built? | A hiring+sourcing+referral+candidate-portal product with LiveKit interviews, offer/placement queues, Gmail/Outlook email, chat/calls/dialer, training LMS, PM kanban — on MongoDB/Express, not the PRD stack |
| Strongest PRD alignment | Job posting, application pipeline, LiveKit video, offer letters, placement queues, training curriculum/attendance/evaluation, unified email inbox, chat + telephony |
| Weakest PRD alignment | Compliance binder, e-sign, calendar sync, interview rubrics, bulk application moves, custom reports, predictive/bias AI, comm legal hold/binder, PM deliverables, supervisor training dashboard, SSO/MFA |

---

## 2. PRD Overview

### Module 1 — Applicant Tracking System (ATS)

| Area | Requirement IDs | Count |
|------|-----------------|------:|
| 1. Job Posting | ATS-JOB-001 … ATS-JOB-005 | 5 |
| 2. Candidate & Compliance | ATS-CAND-001 … ATS-CAND-010 | 10 |
| 3. Recruiter | ATS-REC-001 … ATS-REC-006 | 6 |
| 4. Application Workflow | ATS-APP-001 … ATS-APP-005 | 5 |
| 5. Interview | ATS-INT-001 … ATS-INT-009 | 9 |
| 6. Offer & Placement | ATS-OFF-001 … ATS-OFF-005 | 5 |
| 7. Pre-boarding & Onboarding | ATS-PRE-001 … ATS-PRE-009 | 9 |
| 8. Analytics | ATS-ANA-001 … ATS-ANA-004 | 4 |
| 9. AI Integration | ATS-AI-001 … ATS-AI-007 | 7 |
| **Module 1 total** | | **60** |

### Module 2 — Communication Management

| Area | Requirement IDs | Count |
|------|-----------------|------:|
| Email | COMM-EMAIL-001 … 008 | 8 |
| Chat | COMM-CHAT-001 … 007 | 7 |
| Voice/Video | COMM-VOICE-001 … 004 | 4 |
| File Storage | COMM-FILE-001 … 005 | 5 |
| Dashboards | COMM-DASH-001 … 004 | 4 |
| Security | COMM-SEC-001 … 006 | 6 |
| AI | COMM-AI-001 … 005 | 5 |
| ATS Linkages | COMM-ATS-001 … 005 | 5 |
| **Module 2 total** | | **38** |

### Module 3 — Training Management

| Area | Requirement IDs | Count |
|------|-----------------|------:|
| Curriculum | TRAIN-001 … 004 | 4 |
| Attendance | TRAIN-005 … 007 | 3 |
| Mentor/Supervisor | TRAIN-008 … 010 | 3 |
| Student Dashboard | TRAIN-011 … 014 | 4 |
| Supervisor Dashboard | TRAIN-015 … 018 | 4 |
| Evaluation & Certs | TRAIN-019 … 021 | 3 |
| Analytics | TRAIN-022 … 024 | 3 |
| AI | TRAIN-025 … 029 | 5 |
| **Module 3 total** | | **29** |

### Module 4 — Project & Task Management

| Area | Requirement IDs | Count |
|------|-----------------|------:|
| Project Setup | PM-001 … 004 | 4 |
| Task Board | PM-005 … 008 | 4 |
| Deliverables | PM-009 … 011 | 3 |
| Dashboards | PM-012 … 015 | 4 |
| Progress/Analytics | PM-016 … 019 | 4 |
| Collaboration | PM-020 … 023 | 4 |
| AI | PM-024 … 028 | 5 |
| **Module 4 total** | | **28** |

### PRD tech stack (not implemented as specified)

| PRD choice | Actual implementation | Evidence |
|------------|----------------------|----------|
| NestJS / tRPC | Express ESM | `src/app.js`, `src/routes/v1/` |
| Prisma / PostgreSQL | Mongoose / MongoDB | `src/models/*.model.js` |
| Auth.js (NextAuth) | Custom JWT + Passport | `src/config/passport.js`, `auth.route.js` |
| Casbin | Custom RBAC in Mongo `Role` collection | `src/services/permission.service.js`, `permissions.js` |
| Socket.IO (as specified) | Socket.IO present for chat | `chatSocket.service.js` |
| BullMQ | BullMQ for summaries | `src/queues/summaryQueue.js` |
| Meilisearch / pgvector | Pinecone/Qdrant embeddings | `embeddingSync.scheduler.js`, `pinecone.util.js` |

---

## 3. Current Product Overview

The live product (`dharwinone.com` UAT/staging) is a **multi-role workforce platform**:

- **ATS:** Internal jobs, external job aggregation (RapidAPI), referral leads CRM, applications pipeline, LiveKit interviews, offers, pre-boarding/onboarding queues, analytics.
- **Communication:** Gmail/Outlook unified inbox, real-time chat (DMs + groups), internal meetings, browser dialer (Plivo/Twilio), unified call logs, recordings/transcripts, personal file manager.
- **Training:** Curriculum modules (playlist: video/PDF/quiz/essay/blog), attendance punch system, mentors, student roster, evaluation, analytics, learner `/courses` portal.
- **Projects:** Project CRUD, sprint-aware kanban (Task Board V2), PM analytics, PM Assistant (AI task breakdown + smart assignment), teams directory.
- **Cross-cutting:** Granular RBAC, platform activity logs, notifications, chat assistant (“Sage”), org structure, help & support iframe.

**Naming:** PRD “Candidate” → product **Employees** (`/ats/employees`) with dual `candidates.*` / `employees.*` permission keys.

---

## 4. PRD Coverage Summary

| Module | Reqs | 🟢 | 🟡 | ⚠️ | 🔴 | Strict % | Weighted % |
|--------|-----:|---:|---:|---:|---:|---------:|-----------:|
| ATS (Module 1) | 60 | 19 | 29 | 2 | 10 | 31.7% | 58.3% |
| Communication (Module 2) | 38 | 11 | 16 | 3 | 6* | 28.9% | 57.2% |
| Training (Module 3) | 29 | 12 | 14 | 0 | 3 | 41.4% | 65.5% |
| Projects (Module 4) | 28 | 9 | 11 | 0 | 8 | 32.1% | 51.8% |
| **All modules** | **155** | **51** | **70** | **5** | **27** | **32.9%** | **58.2%** |

\*COMM also has 1 backend-only, 1 UI-only (counted in 🟡/partial column for simplicity in module table; see Section 5 for primary status).

---

## 5. Master PRD Traceability Matrix

### 5.1 Module 1 — ATS (60 requirements)

Full per-requirement matrix with evidence is in `ATS-PRD-AUDIT.md` Part 2. Summary:

| ID | Requirement | Status | Key evidence |
|----|-------------|--------|--------------|
| ATS-JOB-001 | Job fields (org, skills, type, location) | 🟢 | `job.model.js`, `ats/jobs/create/page.tsx` |
| ATS-JOB-002 | Excel import/export | 🟢 | `POST /v1/jobs/export/excel`, `import/excel` |
| ATS-JOB-003 | Full CRUD | 🟢 | `job.route.js`, `ats/jobs/page.tsx` |
| ATS-JOB-004 | Search and sort | 🟢 | `job.service.js`, `JobsFilterPanel` |
| ATS-JOB-005 | Job description templates | 🟢 | `jobTemplate.model.js`, `settings/job-templates` |
| ATS-CAND-001 | Centralised resumes, cover letters | 🟢 | `employee.model.js` documents[], `jobApplication.model.js` |
| ATS-CAND-002 | Multiple resume versions | 🟡 | Multiple uploads; no version workflow |
| ATS-CAND-003 | Tagging skills/experience/keywords | 🟡 | Structured `skills[]`; no free-form tags |
| ATS-CAND-004 | Advanced search/filtering | 🟢 | `employee.service.js` `buildAdvancedFilter` |
| ATS-CAND-005 | Activity history | 🟡 | `activityLog`, notes; no unified timeline UI |
| ATS-CAND-006 | Bulk Excel import/export | 🟢 | `candidateExportXlsx.js`, `ats/employees/import` |
| ATS-CAND-007 | Compliance fields (SEVIS, EAD, degree, supervisor) | 🟡 | Scalar fields + BGV; no compliance module |
| ATS-CAND-008 | Compliance binder PDF/ZIP | 🔴 | `exportProfile` = plain text email only |
| ATS-CAND-009 | Material change logging | 🔴 | `placementAudit.service.js` status only |
| ATS-CAND-010 | Material change version history | 🔴 | Not found |
| ATS-REC-001 | Recruiter profiles + RBAC | 🟢 | `ats/recruiters/*`, `permissions.js` |
| ATS-REC-002 | Recruiter activity logs | 🟡 | `recruiterActivity.service.js`; no per-recruiter UI |
| ATS-REC-003 | Metrics (hires, conversion, time-to-fill) | 🟡 | Analytics; no time-to-fill |
| ATS-REC-004 | Assign recruiters to jobs/departments | 🟡 | `assignRecruiterToCandidate` — person-level only |
| ATS-REC-005 | Workload visibility | 🟡 | Activity leaderboard counts |
| ATS-REC-006 | Notes on candidate/application | 🟡 | Candidate notes wired; `jobApplication.notes` no UI |
| ATS-APP-001 | Pipeline stages | ⚠️ | `atsPipeline.js` — +Shortlisted, +Rejected |
| ATS-APP-002 | Notes, feedback, status | 🟡 | Status per row; notes on candidate only |
| ATS-APP-003 | Automated notifications | 🟢 | `jobApplication.service.js` `notifyByEmail` |
| ATS-APP-004 | Audit trail | 🟡 | Platform `activityLog`; no per-app UI |
| ATS-APP-005 | Bulk-move stages | 🟡 | Single PATCH + offer/placement; no multi-select batch |
| ATS-INT-001 | Multi-round scheduling | 🟡 | Multiple meetings; types Video/In-Person/Phone |
| ATS-INT-002 | Google/Outlook calendar sync | 🔴 | Email invites only; no calendar API |
| ATS-INT-003 | Built-in video | 🟢 | LiveKit `livekit.route.js` |
| ATS-INT-004 | Weighted scoring rubrics | 🔴 | `interviewResult` tri-state only |
| ATS-INT-005 | Central interview dashboard | 🟢 | `InterviewsClient.tsx` |
| ATS-INT-006 | Automated reminders | 🟢 | `meeting.scheduler.js` T-15 |
| ATS-INT-007 | Recording/transcript | 🟡 | Egress + `summaryFinalize.service.js` |
| ATS-INT-008 | Recruiter notes per interview | 🟡 | `meeting.notes`; limited UI |
| ATS-INT-009 | Secure storage/access | 🟢 | `recording.route.js`, `interviews.read/manage` |
| ATS-OFF-001 | Offer letter templates | 🟢 | `OfferLetterGeneratorWorkspace.tsx` |
| ATS-OFF-002 | Digital signature (PRD) | 🔴 | Static CEO signature image on PDF (not e-sign) |
| ATS-OFF-003 | Negotiation version control | 🟡 | Status + `offerLetterHash`; no revision chain |
| ATS-OFF-004 | Placement dashboard | 🟢 | `ats/offers-placement/page.tsx` |
| ATS-OFF-005 | Auto compliance on role change | 🟡 | Placement audit; manual field updates |
| ATS-PRE-001 | Auto checklist on accept | 🟡 | Empty `preBoardingTasks[]` on create |
| ATS-PRE-002 | Identity verification | 🟡 | `verifyDocument`; no IDV vendor |
| ATS-PRE-003 | Payroll setup | 🟡 | CTC on offer; no payroll integration |
| ATS-PRE-004 | IT account creation | 🟡 | `itAccess[]` manual checklist |
| ATS-PRE-005 | Equipment allocation | 🟡 | `assetAllocation[]` manual |
| ATS-PRE-006 | Orientation scheduling | 🟡 | SOP steps; no calendar scheduler |
| ATS-PRE-007 | Compliance acknowledgements | 🟡 | SOP checklists; not legal e-ack |
| ATS-PRE-008 | 7-day onboarding plan | 🟡 | Configurable `onboardingTasks[]` |
| ATS-PRE-009 | Onboarding progress dashboard | 🟢 | `ats/pre-boarding`, `ats/onboarding` |
| ATS-ANA-001 | Detailed metrics | 🟢 | `atsAnalytics.service.js` |
| ATS-ANA-002 | Hiring funnel | 🟢 | `applicationFunnel` |
| ATS-ANA-003 | Exportable dashboards | 🟡 | Client Excel export |
| ATS-ANA-004 | Custom report builder | 🔴 | Not found |
| ATS-AI-001 | Profile from resume parse | 🟡 | Skills + name; manual form save |
| ATS-AI-002 | Call, verify, auto-schedule | 🟡 | Bolna verify; no `createMeeting` |
| ATS-AI-003 | Interview assessment | 🟡 | AI summaries; not scored rubric |
| ATS-AI-004 | Intelligent matching | ⚠️ | `getJobFit` skill overlap, not ML |
| ATS-AI-005 | Predictive insights | 🔴 | Not found |
| ATS-AI-006 | Smart notifications | 🟡 | Cron schedulers; not LLM nudges |
| ATS-AI-007 | Bias detection | 🔴 | Not found |

### 5.2 Module 2 — Communication (38 requirements)

| ID | Requirement | Status | Frontend evidence | Backend evidence |
|----|-------------|--------|-------------------|------------------|
| COMM-EMAIL-001 | Custom domain email | ⚠️ | `communication/email/page.tsx` mailbox lock UI | `emailConnectionPolicy.service.js` — assigned Gmail/Outlook per user, not org DNS |
| COMM-EMAIL-002 | Unified inbox | 🟢 | Multi-account threads, compose | `email.route.js`, `outlook.route.js` |
| COMM-EMAIL-003 | Templates | 🟢 | `settings/email-templates` | `emailTemplate.model.js`, `/v1/email/templates` |
| COMM-EMAIL-004 | AI compose | 🟢 | `generateDraft` in email page | `emailDraftOpenAI.service.js` |
| COMM-EMAIL-005 | Auto-link to ATS | 🔴 | — | No thread FK to candidate/job |
| COMM-EMAIL-006 | Bulk send | 🟡 | Batch label ops | `email.service.js` `queueEmail` — no mail-merge |
| COMM-EMAIL-007 | Retention / legal hold | 🟡 | — | `retentionEnforcer.js` — transcripts only |
| COMM-EMAIL-008 | Communication Binder export | 🔴 | — | Not found |
| COMM-CHAT-001 | DMs | 🟢 | `communication/chats/page.tsx` | `POST /conversations` type `direct` |
| COMM-CHAT-002 | Group channels | 🟢 | Group info panel | `chat.service.js` group CRUD |
| COMM-CHAT-003 | File sharing | 🟢 | Compose attachments | `POST .../messages/upload` |
| COMM-CHAT-004 | Pinning | 🟡 | Dialer pins recents only | `chat.service.js` `pinnedAt`; **no chat pin UI** |
| COMM-CHAT-005 | Mentions | 🟠 | `@Name` text insertion | No structured mention model |
| COMM-CHAT-006 | Read receipts | 🟢 | Checkmarks in chat UI | `readBy`, `deliveredTo` on messages |
| COMM-CHAT-007 | Audit history | 🟡 | Client timeline merge | `GET .../timeline`; not compliance export |
| COMM-VOICE-001 | In-app calls | 🟢 | Chat call button | LiveKit + `chatCall.model.js` |
| COMM-VOICE-002 | Screen share | 🟢 | `stable-video-conference.tsx` | LiveKit screen share track |
| COMM-VOICE-003 | Recording/transcription | 🟡 | `communication/recordings` | Meeting-centric pipeline |
| COMM-VOICE-004 | Call logs | 🟢 | `communication/calling/page.tsx` | `GET /v1/communication/calls` |
| COMM-FILE-001 | Org storage | ⚠️ | `communication/filemanager` | Per-user S3 prefix, not org drive |
| COMM-FILE-002 | Versioning | 🔴 | — | Upload overwrites |
| COMM-FILE-003 | Virus scan | 🟡 | — | MIME allowlist only |
| COMM-FILE-004 | Link to ATS | 🔴 | — | No FK on files |
| COMM-FILE-005 | Retention | 🔴 | — | No file retention policy |
| COMM-DASH-001 | Admin comm dashboard | 🔴 | — | Not found |
| COMM-DASH-002 | Recruiter comm dashboard | 🔴 | — | ATS analytics only |
| COMM-DASH-003 | Supervisor comm dashboard | 🔴 | — | Not found |
| COMM-DASH-004 | Candidate comm dashboard | 🔴 | — | Inbox access, not insights |
| COMM-SEC-001 | RBAC | 🟢 | `route-permissions.ts` | `permissions.js` emails/chats/calls/files |
| COMM-SEC-002 | SSO / MFA | 🔴 | Template 2FA pages unwired | JWT login only |
| COMM-SEC-003 | Encryption | 🟡 | TLS, S3 presigned | No documented at-rest policy |
| COMM-SEC-004 | DLP | 🔴 | — | Not found |
| COMM-SEC-005 | Audit logs | 🟡 | Activity logs module | Partial comm event logging |
| COMM-SEC-006 | Recording consent | 🔴 | — | No consent capture before record |
| COMM-AI-001 | Email copilot | 🟢 | Compose AI panel | `POST /v1/email/drafts/generate` |
| COMM-AI-002 | Meeting copilot | 🟡 | Transcript modal | Post-hoc `summaryFinalize.service.js` |
| COMM-AI-003 | File search | 🟡 | Filename search | S3 name scan; not semantic |
| COMM-AI-004 | Smart routing | 🔴 | — | Not found |
| COMM-AI-005 | Risk/compliance detection | ⚠️ | — | `callQuality.needs_review` heuristic only |
| COMM-ATS-001 | Link to candidate | 🟡 | Dialer contact context | `callRecord.candidate` |
| COMM-ATS-002 | Link to job | 🟡 | — | Bolna job verification calls |
| COMM-ATS-003 | Link to interview | 🔴 | — | Meetings separate from comm linker |
| COMM-ATS-004 | Link to offer | 🔴 | — | Offer emails not in unified inbox |
| COMM-ATS-005 | Link to onboarding | 🔴 | — | Not found |

### 5.3 Module 3 — Training (29 requirements)

| ID | Requirement | Status | Key evidence |
|----|-------------|--------|--------------|
| TRAIN-001 | Weekly modules | 🟡 | `playlist[].sectionTitle`; no week entity |
| TRAIN-002 | Templates | 🟡 | Clone + AI generate; no template library |
| TRAIN-003 | Multimedia content | 🟢 | 6 playlist types, S3 uploads |
| TRAIN-004 | Assign to groups | 🟡 | categories/positions/students; `StudentGroup` = attendance holidays |
| TRAIN-005 | Auto attendance logging | 🟢 | Punch in/out + `attendance.scheduler.js` |
| TRAIN-006 | Attendance reports | 🟢 | `/track/export`, calendar UI |
| TRAIN-007 | Absenteeism alerts | 🔴 | UI infers absence; no alert pipeline |
| TRAIN-008 | Mentor assignment | 🟢 | `mentorsAssigned`, `training/mentors` |
| TRAIN-009 | Supervisor dashboards | 🔴 | No training supervisor role/route |
| TRAIN-010 | Mentor feedback | 🟡 | Student notes; no structured mentor loop |
| TRAIN-011 | Student schedule | 🟡 | localStorage reminder modal only |
| TRAIN-012 | Student progress | 🟢 | `studentCourseProgress.model.js`, `/courses` |
| TRAIN-013 | Student materials | 🟢 | Learn experience pages |
| TRAIN-014 | Student notifications | 🟡 | Cert issue notification; sparse elsewhere |
| TRAIN-015 | Supervisor attendance approvals | 🟡 | Backdated/leave requests; admin-gated |
| TRAIN-016 | Supervisor progress oversight | 🟡 | Admin evaluation page |
| TRAIN-017 | Flag issues | 🟡 | `computeAtRisk` staleness heuristic |
| TRAIN-018 | Supervisor feedback | 🟡 | Same as TRAIN-010 |
| TRAIN-019 | Evaluations | 🟢 | `evaluation.service.js`, quiz/essay |
| TRAIN-020 | Grading | 🟢 | Auto quiz + AI/manual essay |
| TRAIN-021 | Auto certificates | 🟡 | Record + verify code; **no PDF** |
| TRAIN-022 | Performance metrics | 🟢 | `training/analytics/page.tsx` |
| TRAIN-023 | Trends | 🟢 | enrollments/completions/quiz over time |
| TRAIN-024 | Exportable reports | 🟢 | Evaluation + attendance Excel |
| TRAIN-025 | Adaptive learning | 🔴 | Sequential quiz lock only |
| TRAIN-026 | Smart evaluation | 🟡 | AI essay when `expectedAnswer` set |
| TRAIN-027 | Engagement monitoring | 🟡 | At-risk = stale progress |
| TRAIN-028 | Content summarization | 🟡 | Authoring-time AI; not learner-facing |
| TRAIN-029 | Teaching assistant | 🟡 | Module-builder AI chat; no in-course TA |

### 5.4 Module 4 — Projects (28 requirements)

| ID | Requirement | Status | Key evidence |
|----|-------------|--------|--------------|
| PM-001 | Project brief (goals/scope) | 🟡 | `description` + intake fields + AI enhance |
| PM-002 | Tech stack metadata | 🔴 | Tags only |
| PM-003 | Link to training | 🔴 | No FK on Project |
| PM-004 | Link to hiring | 🟡 | AI assignment → job draft side path |
| PM-005 | Kanban stages | 🟡 | 5 columns; extra NEW; naming differs |
| PM-006 | Assign tasks | 🟢 | `task.model.js` `assignedTo[]` |
| PM-007 | Sub-tasks | 🔴 | No `parentTaskId` |
| PM-008 | Drag-and-drop | 🟢 | `@dnd-kit` TaskBoard V2 |
| PM-009 | Upload with hash | 🔴 | No deliverable model |
| PM-010 | Version history | 🔴 | Not found |
| PM-011 | Pass/Revise/Reject review | 🔴 | Training essay grading only |
| PM-012 | Admin dashboard | 🟡 | PM analytics + project list |
| PM-013 | Supervisor dashboard | 🔴 | Not found |
| PM-014 | Student dashboard | 🔴 | No PM widgets on candidate dashboard |
| PM-015 | Recruiter dashboard | 🔴 | ATS analytics only |
| PM-016 | Real-time dashboards | 🟡 | Refetch on focus; `TaskRealtimeProvider` empty stub |
| PM-017 | Completion rates | 🟢 | `getProjectProgress`, analytics donuts |
| PM-018 | Exportable reports | 🟢 | `exportPmAnalyticsToExcel` |
| PM-019 | Overdue alerts | 🟡 | Analytics lists; no cron/email |
| PM-020 | Project chat/files | 🔴 | Global chat; no `projectId` on conversations |
| PM-021 | Comment threads | 🟢 | `TaskCommentsSection`, embedded comments |
| PM-022 | Notifications | 🟡 | Assign + status change notifications |
| PM-023 | Link communications | 🔴 | Email not tied to projects |
| PM-024 | Smart task assignment | 🟢 | `pmAssistant.service.js` assignment runs |
| PM-025 | Progress summaries | 🟡 | Chatbot task board analytics |
| PM-026 | Quality insights | 🔴 | Not found |
| PM-027 | Risk prediction | 🟡 | Due-date heuristic in `MyProjectsCard` |
| PM-028 | Productivity assistant | 🟢 | Task breakdown + smart team bootstrap |

---

## 6. Fully Implemented Functionality

**ATS (19):** ATS-JOB-001–005, ATS-CAND-001/004/006, ATS-REC-001, ATS-APP-003, ATS-INT-003/005/006/009, ATS-OFF-001/004, ATS-PRE-009, ATS-ANA-001/002.

**Communication (11):** COMM-EMAIL-002/003/004, COMM-CHAT-001/002/003/006, COMM-VOICE-001/002/004, COMM-SEC-001, COMM-AI-001.

**Training (12):** TRAIN-003/005/006/008/012/013/019/020/022/023/024.

**Projects (9):** PM-006/008/017/018/021/024/028.

---

## 7. Partially Implemented Functionality

See Section 5 matrices (🟡 rows). Highest-impact partials:

| Requirement | What exists | What is missing | Current UX |
|-------------|-------------|-----------------|------------|
| ATS-CAND-008 binder | Document verify, share profile | PDF/ZIP assembly | Recruiters request/verify docs manually |
| ATS-AI-002 Bolna | Verification calls stored | Auto `createMeeting` after confirm | Recruiter schedules interview manually |
| ATS-APP-005 bulk move | Single status PATCH | Batch API + UI | One application at a time |
| COMM-EMAIL-005 ATS link | Bolna call links | Email thread auto-match | Manual context switching |
| TRAIN-021 certificates | Eligibility + verify API | PDF generation | Certificate record without download |
| PM-005 kanban | 5-column board | PRD 4-stage naming | Extra NEW column; TODO ≠ Backlog |

---

## 8. Missing Functionality

### P0 — Critical / core

| Priority | ID | Requirement | Evidence of absence |
|----------|-----|-------------|---------------------|
| P0 | ATS-CAND-008 | Compliance binder PDF/ZIP | `employee.controller.js` export = plain text |
| P0 | ATS-OFF-002 | Digital signature | No e-sign provider integration |
| P0 | ATS-APP-005 | Bulk application stage move | No batch route in `jobApplication.route.js` |
| P0 | COMM-EMAIL-008 | Communication binder | Not found in comm module |
| P0 | PM-009–011 | Deliverables/submissions | No deliverable model |

### P1 — Major workflow

| Priority | ID | Requirement |
|----------|-----|-------------|
| P1 | ATS-INT-002 | Google/Outlook calendar sync |
| P1 | ATS-INT-004 | Weighted interview rubrics |
| P1 | ATS-CAND-009/010 | Material change logging + version history |
| P1 | ATS-ANA-004 | Custom report builder |
| P1 | COMM-SEC-002 | SSO / MFA |
| P1 | TRAIN-009 | Supervisor training dashboard |
| P1 | PM-007 | Sub-tasks |

### P2 — Supporting

| Priority | ID | Requirement |
|----------|-----|-------------|
| P2 | ATS-REC-003 | Time-to-fill metric |
| P2 | ATS-PRE-001 | Auto pre-boarding checklist on accept |
| P2 | TRAIN-007 | Absenteeism alerts |
| P2 | COMM-DASH-001–004 | Role communication dashboards |
| P2 | PM-013–015 | Role PM dashboards |

### P3 — Nice-to-have / AI aspirations

| Priority | ID | Requirement |
|----------|-----|-------------|
| P3 | ATS-AI-005/007 | Predictive insights, bias detection |
| P3 | TRAIN-025 | Adaptive learning |
| P3 | PM-026 | AI quality insights on deliverables |
| P3 | COMM-AI-004 | Smart routing |

---

## 9. UI / Placeholder Functionality

| ID | Item | Evidence |
|----|------|----------|
| COMM-CHAT-005 | Structured mentions | UI inserts plain `@Name`; no backend parsing or notifications |
| ATS (extra) | Public-apply captcha | `public.route.js` checks token presence; no provider wired |

---

## 10. Backend-Only Functionality

| Item | Backend | Missing UI |
|------|---------|------------|
| Placement status audit | `GET /placements/:id/audit`, `placementAudit.service.js` | No ATS audit viewer |
| Chat conversation pin | `PATCH .../preferences` `{ pinned }` | No frontend client for pin |
| COMM-ATS call `relatedTo` linker | `callRecord.model.js` polymorphic FK | Not surfaced in Communication UI |

---

## 11. Functionality Implemented Differently

| ID | PRD expectation | Actual implementation | Evidence |
|----|-----------------|----------------------|----------|
| ATS-APP-001 | Applied→Screening→Interview→Offer→Hired | 7 statuses + reopen from Rejected | `atsPipeline.js` |
| ATS-AI-004 | ML intelligent matching | Deterministic skill overlap | `getJobFit`, `matchJobsForCandidate` |
| COMM-EMAIL-001 | Org custom-domain email | Per-user assigned mailbox OAuth lock | `emailConnectionPolicy.service.js` |
| COMM-FILE-001 | Org-wide storage | Per-user S3 folders | `fileStorage.service.js` |
| COMM-AI-005 | Compliance language detection | Call quality `needs_review` flag | `callRecord.model.js` |
| TRAIN-004 | Assign modules to groups | Category/position/student lists; StudentGroup = holidays | `trainingModule.model.js` |
| PM-005 | Backlog→In Progress→Review→Done | new/todo/on_going/in_review/completed | `task.model.js` |

---

## 12. Functionality Built Beyond the PRD

### Module 1 — ATS extras (32 documented in `ATS-PRD-AUDIT.md` Part 13A)

| ID | Feature | Status | Where found | PRD coverage |
|----|---------|--------|-------------|--------------|
| EXTRA-ATS-01 | External jobs + Apollo + auto-fetch | 🟢 | `externalJob.route.js`, `ats/external-jobs` | Not mentioned |
| EXTRA-ATS-02 | Referral leads CRM + HMAC links | 🟢 | `referralLeads.service.js`, `ats/referral-leads` | Not mentioned |
| EXTRA-ATS-03 | Sales-agent attribution lock/override | 🟢 | `salesAgentAttribution.service.js` | Not mentioned |
| EXTRA-ATS-04 | Share-candidate onboarding tokens | 🟢 | `ats/share-candidate-form`, `/candidate-onboard` | Not mentioned |
| EXTRA-ATS-05 | Public job board + apply | 🟢 | `/public-job`, `public.route.js` | Related, beyond PRD |
| EXTRA-ATS-06 | Candidate self-service portal | 🟢 | `browse-jobs`, `my-applications`, `my-profile` | Not mentioned |
| EXTRA-ATS-07 | Public recruiter profiles | 🟢 | `/public-recruiter/[id]` | Not mentioned |
| EXTRA-ATS-08 | Candidate SOP + offboarding SOP | 🟢 | `candidateSopTemplate`, `offboardingSop` | Related, beyond PRD |
| EXTRA-ATS-09 | LiveKit waiting room | 🟢 | `livekit.route.js` admit/deny | Related, beyond PRD |
| EXTRA-ATS-10 | Internal transfer post-interview | 🟢 | `POST /meetings/:id/internal-transfer` | Not mentioned |
| EXTRA-ATS-11 | Click-to-call (Plivo/Twilio) | 🟢 | `CallNowButton.tsx`, dialer | Not mentioned |
| EXTRA-ATS-12 | Bolna job verification calls | 🟢 | `jobVerificationCall.scheduler.js` | Not mentioned |
| EXTRA-ATS-13 | Job bookmarks | 🟢 | `GET/POST /jobs/:id/bookmarks` | Not mentioned |
| EXTRA-ATS-14 | LMS in ATS nav (Courses) | 🟢 | sidebar Courses, SOP training assign | Not mentioned |
| EXTRA-ATS-15 | HRMS on ATS employees | 🟢 | week-off, shift, attendance on employees list | Not mentioned |
| … | (see `ATS-PRD-AUDIT.md` rows 16–32) | | | |

### Module 2 — Communication extras

| ID | Feature | Evidence | PRD coverage |
|----|---------|----------|--------------|
| EXTRA-COMM-01 | Bolna AI voice agent (candidate/job verify) | `bolna.route.js` | Not in comm PRD |
| EXTRA-COMM-02 | Plivo/Twilio browser dialer + company numbers | `plivo.route.js`, `communication/dialer` | Not mentioned |
| EXTRA-COMM-03 | Unified call feed (AI + PSTN + in-app) | `communication/calling` | Beyond PRD |
| EXTRA-COMM-04 | Internal meetings module | `internalMeeting.route.js` | Not mentioned |
| EXTRA-COMM-05 | HR Chat Assistant (Sage) | `chatAssistant.service.js` | Different from PRD copilot |
| EXTRA-COMM-06 | Contact directory RBAC + exact-email lookup | `communicationAccess.js` | Not mentioned |
| EXTRA-COMM-07 | Chat reactions, reply, forward, delete | `chat.route.js` | Not mentioned |
| EXTRA-COMM-08 | Twilio Conversational Intelligence | `callRecord.intelligence` | Not mentioned |
| EXTRA-COMM-09 | Canned responses | `cannedResponse.route.js` | Not mentioned |
| EXTRA-COMM-10 | Company work-email assignment | `company-email.*` perms | Not mentioned |

### Module 3 — Training extras

| ID | Feature | Evidence |
|----|---------|----------|
| EXTRA-TRAIN-01 | ATS→training handoff on Joined | `placementTrainingHook.service.js` |
| EXTRA-TRAIN-02 | AI module builder (SSE, doc upload) | `create-with-ai/page.tsx` |
| EXTRA-TRAIN-03 | Category↔Position↔Module matrix | `CategoriesTab.tsx` |
| EXTRA-TRAIN-04 | Week-off bulk import/export | `weekOffExport.controller.js` |
| EXTRA-TRAIN-05 | Quiz sequential lock | `quizSequentialLock.service.js` |
| EXTRA-TRAIN-06 | Public certificate verification | `certificate.route.js` `/verify/:code` |
| EXTRA-TRAIN-07 | Course learner notes per item | `courseLearnerNote.model.js` |

### Module 4 — Projects extras

| ID | Feature | Evidence |
|----|---------|----------|
| EXTRA-PM-01 | Sprint management | `sprint.model.js` |
| EXTRA-PM-02 | Human-readable task codes (DHRW-001) | `pmTaskCode.js` |
| EXTRA-PM-03 | PM Teams directory + Excel import | `project-management/teams` |
| EXTRA-PM-04 | Task Board V2 (virtualization, saved views, bulk) | `task/kanban-board/` |
| EXTRA-PM-05 | AI bootstrap smart team | `pmAssistant.service.js` |
| EXTRA-PM-06 | Assignment → ATS job draft | `assignment-runs/.../job-draft` |
| EXTRA-PM-07 | Offboarding task flags (leaving/reassigned) | `task.service.js` |

---

## 13. Current Page-by-Page Product Audit

| Page | Route | Current functionality | PRD coverage | Extra functionality | Major gaps | Recent changes (Git) |
|------|-------|----------------------|--------------|---------------------|------------|----------------------|
| Dashboard | `/dashboard` | Role-specific home (employee punch, sales-agent referral, widgets) | Partial (no PRD dashboards) | Sales-agent dashboard, on-leave card | No comm/training supervisor dashboards | `cc714237` wizard; pagination fixes Sep 2026 |
| Jobs | `/ats/jobs` | CRUD, filters, Excel, templates, bookmarks, share | ATS-JOB full | External job parity filters, vacancies column | — | Sticky header `e22b7e76`; pagination `9fd031de` |
| Applications | `/ats/applications` | Pipeline list, status update, filters | ATS-APP partial | Multi-app per applicant view | Bulk move, app notes UI | Server pagination `757dd42a`; restored after job-applications removal |
| External Jobs | `/ats/external-jobs` | Search, save, auto-fetch, Apollo contacts | Not in PRD | Full module | — | Dark mode `5cafd148`; auto-fetch UI `9ed5ae2b` |
| Employees | `/ats/employees` | Candidate CRUD, docs, compliance fields, HRMS ops | ATS-CAND partial | Click-to-call, share, feedback stars | Binder, material history | Scope fix `a41908b`; pagination Sep 2026 |
| Referral Leads | `/ats/referral-leads` | CRM board, attribution, export, pipeline status | Not in PRD | Full module | — | Unified STATUS column `b5398f54` |
| Share Candidate Form | `/ats/share-candidate-form` | Token invites, Excel batch | Not in PRD | Full module | — | — |
| Browse Jobs | `/ats/browse-jobs` | Candidate job board | Partial | Self-service | — | — |
| My Applications | `/ats/my-applications` | Withdraw, lifecycle badges | Partial | Stage-aware resolver `aa7f62f7` | — | Badge unification `72ee54c7` |
| Courses | `/courses` | Learner catalog + learn experience | TRAIN student | ATS handoff | In-course TA | Waiting room UI `94ffd8be` |
| Recruiters | `/ats/recruiters` | CRUD, Excel, public profile | ATS-REC partial | Excel import/export | Activity tab, time-to-fill | — |
| Interviews | `/ats/interviews` | Schedule, week view, LiveKit, results | ATS-INT partial | Waiting room, recordings, transfer | Rubrics, calendar sync | Default sort latest `615c227f`; removed duplicate job-applications nav `da120383` |
| Offers & Placement | `/ats/offers-placement` | Offer CRUD, letter generator, queues | ATS-OFF partial | Compensation gate, bulk delete | E-sign | Touch targets `73ff6424` |
| Pre-boarding | `/ats/pre-boarding` | Queue, BGV, assets, IT, docs | ATS-PRE partial | SOP integration | Auto checklist on accept | Stage param `b0abf566`; split from combined page |
| Onboarding | `/ats/onboarding` | Queue, tasks, training assign | ATS-PRE partial | Joining reminders | Payroll/IT vendors | Pagination `9fd031de` |
| Analytics | `/ats/analytics` | Funnel, leaderboard, Excel | ATS-ANA partial | Drill-down widgets | Custom reports, time-to-fill | — |
| Email | `/communication/email` | Gmail/Outlook unified inbox | COMM-EMAIL partial | Mailbox lock | ATS auto-link, binder | AI drafts wired |
| Chats | `/communication/chats` | DMs, groups, calls, attachments | COMM-CHAT partial | Reactions, timeline | Structured mentions, pin UI | Delivery ACK backend `5cfb819` |
| Meetings | `/communication/meetings` | Internal meetings list/schedule | Not in PRD | Full module | — | Search/date filters `58ca852` |
| Dialer | `/communication/dialer` | Browser softphone | Not in PRD | Plivo/Twilio | — | Provider split `ca7c2d03` |
| Calling | `/communication/calling` | Unified call log | COMM-VOICE partial | AI + telephony filter | Comm dashboards | `327ea437` |
| Recordings | `/communication/recordings` | Transcript/summary viewer | COMM-AI partial | — | Consent flow | Added `da120383` |
| File Manager | `/communication/filemanager` | Personal file upload/list | COMM-FILE partial | — | Org storage, versioning | — |
| Training Curriculum | `/training/curriculum/*` | Modules, categories, positions, AI builder | TRAIN-001–004 partial | AI module builder | Weekly model, template library | `8f233ba3` training changes |
| Attendance | `/training/attendance` | Punch, calendar, export | TRAIN-005/006 | Backdated requests | Absenteeism alerts | — |
| Mentors | `/training/mentors` | Mentor CRUD | TRAIN-008 | — | — | — |
| Students | `/training/students` | Roster, filters, export | TRAIN partial | Skills overlay from Employee | Supervisor dashboard | Overlay fix `f829159` backend |
| Evaluation | `/training/evaluation` | Progress, essay grading, at-risk | TRAIN-019/020 | At-risk overlay | Supervisor-scoped view | Export label fix `9fc33ae` |
| Training Analytics | `/training/analytics` | Metrics, trends, Excel | TRAIN-022–024 | Period comparison | AI insights | — |
| Project List | `/apps/projects/project-list` | Project CRUD | PM-001 partial | AI brief enhance | Tech stack field | — |
| My Projects | `/apps/projects/my-projects` | Scoped project list | PM-012 partial | RBAC `my-projects.read` | — | — |
| My Tasks | `/task/my-tasks` | Assigned tasks | PM partial | — | — | — |
| Kanban Board | `/task/kanban-board` | Task Board V2 DnD | PM-005/008 | Sprints, saved views, bulk | PRD column names | E2E removed `5c950dd7` |
| PM Teams | `/project-management/teams` | Teams + Excel | EXTRA | Import/export | — | — |
| PM Analytics | `/project-management/analytics` | Donuts, exports | PM-017/018 | Chatbot queries | Realtime | Donut rework `0bffc6a5` |
| Org Structure | `/organization/*` | Chart, departments, directory, scenarios | Not in PRD | Full org module | — | Reparent modal `6680ed3d` |
| Activity Logs | `/logs/logs-activity` | Platform audit | Partial COMM-SEC-005 | Geo/IP headers | Comm-specific audit | Entity names `e10f8435` |
| Help & Support | `/help-and-support` | iframe help | Not in PRD | — | — | `b05986a9` |
| Settings | `/settings/*` | Job templates, SOP, email templates, agents, telephony, offboarding | Various | Many ATS-adjacent | Bolna voice settings UI removed | See Section 18 |

**Public routes (unauthenticated):** `/public-job`, `/public-job/[jobId]`, `/public-recruiter/[id]`, `/public-employee/[id]`, `/candidate-onboard`, `/join/room`.

---

## 14. Git History / Product Evolution

### Repository timeline

| Repo | First commit | Notes |
|------|--------------|-------|
| `uat.dharwin.backend` | 2026-02-02 (`bcf0ed5`) | Training APIs from Feb 9; ATS grew through Feb–Sep 2026 |
| `uat.dharwin.frontend` | 2026-02-02 (`bd23a07c`) | Parallel evolution; LiveKit phases Feb 2026 |

### Major feature introduction (approximate, from commit messages)

| Period | Features introduced | Representative commits |
|--------|---------------------|------------------------|
| Feb 2026 | Training module, mentors, students, S3 uploads | `546a90a`, `4cdca3e` |
| Feb 2026 | LiveKit interviews phase 1–3 | `d4b77f35`, `14220c6c`, `5ccc956b` |
| Feb–Mar 2026 | Internal meetings, HRM monitoring | `54c811ba`, `c5e42133` |
| Mar–Apr 2026 | Offer letter workspace, employees, referral leads, pre-boarding | `6e34407c`, `81c74cfb`, `e85d9e79` |
| May 2026 | External jobs RapidAPI integration | `26dc20c` |
| May–Jun 2026 | Referral attribution, sales agents, telephony Plivo/Twilio | `aa6dc41`, `7dc24cd`, `a604832` |
| Jun 2026 | Offboarding SOP, org structure UI | `2755501`, `2a6478f2` |
| Jul–Aug 2026 | PM task breakdown V2, dialer, external jobs auto-fetch | `bbd9b9b5`, `d328ee8`, `327ea437` |
| Aug–Sep 2026 | Directory RBAC, pagination at scale, stage-aware lifecycle, mobile app auth | `ae9e2e8`, `9fd031de`, `e0b297f`, `182f628` |

### Architectural evolution

1. **Monolithic Express + MongoDB** chosen over PRD’s NestJS/Postgres — consistent from initial commit.
2. **ATS pipeline expanded** from PRD’s 5 stages to 7 application statuses + placement sub-statuses (`atsPipeline.js` commits through 2026).
3. **Communication stack grew organically:** email → chat → LiveKit → Plivo/Twilio dialer → unified call feed → directory RBAC (Aug 2026).
4. **Kanban rebuilt** as Task Board V2 (`@dnd-kit`, virtualization); legacy `KanbanTaskCard.tsx` deleted (`bbd9b9b5`).
5. **Pagination hardening** across ATS/training/settings (Sep 2026) — response to scale, not PRD requirement.

---

## 15. Page-by-Page Git Change History

### ATS Jobs

**Page:** ATS Jobs  
**Path:** `uat.dharwin.frontend/app/(components)/(contentlayout)/ats/jobs/page.tsx`  
**Current functionality:** Job list with filters, CRUD links, Excel export, vacancy column, sticky header.  
**PRD:** ATS-JOB-001–005  

| Date | Commit | Change | Why (evidence) |
|------|--------|--------|----------------|
| 2026-02+ | `861300bd` | Vacancies field, filter drawer redesign | Feature expansion — commit message describes new field |
| 2026-07 | `f2aca947` | Sticky table layouts | UX polish — internal |
| 2026-07 | `556faebb` | Title overlap fix on narrow layouts | Bugfix — internal |
| 2026-09 | `9fd031de` | Server-side pagination | Scale — internal engineering |
| 2026-09 | `e22b7e76` | Opaque sticky header | UX — internal |

### ATS Interviews

**Page:** ATS Interviews  
**Path:** `.../ats/interviews/page.tsx`  
**PRD:** ATS-INT-001–009  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-02 | `d4b77f35` | LiveKit phase 1 | Feature build — internal |
| 2026-02 | `94ffd8be` | Waiting room UI | Feature expansion — internal |
| 2026-02 | `da120383` | Interview result flow; **removed** `job-applications/page.tsx` from nav | Consolidation — applications unified; reason not client-stated |
| 2026-06 | `6e905ceb` | Internal transfer UI | Feature beyond PRD — internal |
| 2026-09 | `615c227f` | Default sort latest first | UX — internal |

### ATS Pre-boarding / Onboarding

**Paths:** `.../ats/pre-boarding/page.tsx`, `.../ats/onboarding/page.tsx`  
**PRD:** ATS-PRE-001–009  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-03 | `81c74cfb` | Pre-boarding queue, offer letter, onboarding, referral leads | Major ATS milestone — internal feature batch |
| 2026-04 | `78d03df1` | Remove manual pre-boarding status; derive from workflow | Workflow refinement — internal |
| 2026-05 | `b0abf566` | Drive queues by `stage` param | API alignment — internal |
| 2026-06 | `d0697fd3` | Delete combined `pre-boarding-onboarding/page.tsx` stub | Cleanup — internal |
| 2026-09 | `73ff6424` | Touch targets 44px | Mobile UX — internal |

### Referral Leads

**Path:** `.../ats/referral-leads/`  
**PRD:** Not in PRD  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-03 | `fda2177b` | Initial referral leads + job apply UX | New product area — internal |
| 2026-05 | `6601df8` | Unify STATUS/STAGE into one pipeline | Data model simplification — internal |
| 2026-06 | `ffe025b` | Sales-agent scoping | RBAC — internal |
| 2026-09 | `e3d57768` | Hardened date picker | Bugfix (Chromium 5-digit year) — internal |

### External Jobs

**Path:** `.../ats/external-jobs/`  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-05 | `26dc20c` (BE) | RapidAPI integration | Sourcing feature — internal |
| 2026-07 | `d328ee8` (BE) | Auto-fetcher scheduler | Automation — internal |
| 2026-07 | `9ed5ae2b` (FE) | Auto-fetch UI | Paired frontend — internal |
| 2026-09 | `1f1de082` | Posting UX, work arrangement display | UX polish — internal |

### Communication / LiveKit

**Paths:** `communication/*`, `join/room`, LiveKit components  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-02 | `5ccc956b` | LiveKit meeting rooms | PRD interview video — internal |
| 2026-02 | `da120383` | Recordings page added | PRD recording — internal |
| 2026-05 | `23016ec` (BE) | Waiting-room rejection signal | UX fix — internal |
| 2026-06 | `fcaa6a26` | **Removed** Bolna voice agent settings UI | Refactor — "remove dead UI"; reason not client-stated |
| 2026-07 | `327ea437` | Dialer + external jobs + logs UI | Integration batch — internal |
| 2026-08 | `bcd4b7ea` | Chat directory RBAC gating | Security — internal |

### Training

**Paths:** `training/*`, `courses/*`  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-02 | `546a90a` (BE) | Training module APIs | PRD Module 3 — internal |
| 2026-09 | `f829159` (BE) | Overlay Candidate skills on student list | Data consistency fix — internal |
| 2026-09 | `9fc33ae` (BE) | Evaluation filter after aggregation | Bugfix — internal |

### Projects / Kanban

**Path:** `task/kanban-board/`  

| Date | Commit | Change | Why |
|------|--------|--------|-----|
| 2026-06 | `bbd9b9b5` | Task Board V2; deleted legacy kanban components | Rebuild — internal |
| 2026-07 | `5c950dd7` | Scope view-only users; **removed Playwright e2e** | Security + test cleanup — internal |
| 2026-09 | `04ce0cc5` | Toolbar padding | UX — internal |

---

## 16. Client-Driven Changes

**Important:** Few commits explicitly state client/UAT/customer requests. Classifications below use commit-message evidence only.

### 🟢 CONFIRMED CLIENT REQUEST

| Date | Commit | Page/Module | Change | Evidence | Confidence |
|------|--------|-------------|--------|----------|------------|
| 2026-05* | `ec9ea71` (BE) | Telephony / Plivo | One-shot Plivo provisioning script | Message: "client account migration" | 🟢 CONFIRMED |

\*Approximate date from commit position in history; exact date not re-fetched.

### 🟡 LIKELY CLIENT REQUEST (strong indirect evidence, not explicit)

| Date | Commit | Page/Module | Change | Evidence | Confidence |
|------|--------|-------------|--------|----------|------------|
| 2026-09 | `9fc33ae` (BE) | Training Evaluation | Export column "User" not "Student" | Terminology change suggesting client language preference | 🟡 LIKELY |
| 2026-06 | `d80a72b` (BE) | Offers | Forbid client override of compensationType | "client" = API consumer; **not** business client | ⚪ N/A — engineering term |

### 🔵 INTERNAL PRODUCT/ENGINEERING CHANGE (sample — majority of commits)

| Date | Commit | Change | Evidence |
|------|--------|--------|----------|
| 2026-02 | `da120383` | Removed standalone Job Applications page | Consolidated into Applications; no client mention |
| 2026-06 | `fcaa6a26` | Removed Bolna voice agent settings UI | "remove dead stub", RBAC alignment |
| 2026-08 | `ae9e2e8`–`f8d01ad` | Contact discovery RBAC series | Security hardening commit series |
| 2026-09 | `9fd031de`, `757dd42a`, `e10f8435` | Pagination at scale across ATS | Performance engineering |
| 2026-09 | `e0b297f`, `aa7f62f7` | Stage-aware candidate lifecycle | Product refinement |

### ⚪ UNKNOWN

Most UI polish, dark-mode fixes, and mobile responsiveness commits (e.g. `5cafd148`, `73ff6424`, `9f15ecb8`) have **no client attribution** in messages. Reason for change could not be established from available Git history.

### Client request categories searched but not found

No commits matched: `as per client`, `client asked`, `client want`, `UAT feedback`, `customer request`, `change requested` (frontend/backend grep returned empty or only engineering uses of "client").

---

## 17. Features Implemented Then Changed

| Feature | Original implementation | Current implementation | Git commit(s) | Change | Reason | Evidence |
|---------|------------------------|------------------------|---------------|--------|--------|----------|
| Job Applications page | Standalone `/ats/job-applications` | Merged into `/ats/applications` | `da120383` (2026-02-23) | Page removed, nav updated | Reason not established from Git history | 520 lines deleted |
| Pre-boarding + Onboarding combined | Single `pre-boarding-onboarding/page.tsx` | Split `/ats/pre-boarding` + `/ats/onboarding` | `81c74cfb` → `d0697fd3` | Split then stub deleted | Workflow clarity — internal | File delete in `d0697fd3` |
| Bolna voice agent settings | `settings/bolna-voice-agent/page.tsx` | Removed; backend Bolna remains | `fcaa6a26` (2026-06-01) | UI deleted | "remove dead stub" — internal | 539 lines deleted |
| Kanban board | Legacy `KanbanTaskCard`, `TaskDetailModal` | Task Board V2 (`@dnd-kit`) | `bbd9b9b5` | Rebuild | Scale/a11y — internal | Deleted legacy components |
| Application pipeline | PRD 5-stage sketch | 7 statuses + reopen | Multiple `atsPipeline.js` edits | Expanded enum | Product evolution — internal | `atsPipeline.js` |
| "AI matching" | Marketed as AI in PRD | Skill overlap scoring | — | ⚠️ Different algorithm | Implementation choice — internal | `getJobFit` |
| Pre-boarding status field | Manual status on placement | Derived from workflow stage | `78d03df1` | Field removed from UI | Consistency — internal | Commit message |
| Referral STATUS + STAGE columns | Two columns | Single STATUS pipeline | `6601df8`, `b5398f54` | UI simplification | UX — internal | Frontend commits |
| Employee export | Raw IDs in places | Entity names in activity logs | `ee13d8e`, `e10f8435` | Display fix | UX — internal | Sep 2026 |
| Compensation on offers | Direct edit | Placement-aware confirmation gate | `c9ce4321`, `ee10eb88` | Safety guard | Data integrity — internal | Sep 2026 |
| Chat pin | Backend `pinnedAt` | Still backend-only | — | UI never shipped | Incomplete feature | No FE API client |
| Task list view page | `/task/list-view` | Deleted stub | `d0697fd3` | Removed | Dead page cleanup | Git delete |

---

## 18. Historically Implemented / Removed Functionality

| Feature | Previous file/component | Relevant commit | Approx. date | What it did | Current state | PRD still requires? | Client removal? |
|---------|------------------------|-----------------|--------------|-------------|---------------|---------------------|-----------------|
| Standalone Job Applications page | `ats/job-applications/page.tsx` | `da120383` | 2026-02-23 | Separate applications view | Functionality on `/ats/applications` | Yes (workflow) — still exists elsewhere | Unknown |
| Combined pre-boarding-onboarding page | `ats/pre-boarding-onboarding/page.tsx` | `d0697fd3` | 2026-06 | Single combined queue | Split into two pages | Yes — implemented differently | Unknown |
| Bolna voice agent settings UI | `settings/bolna-voice-agent/page.tsx` | `fcaa6a26` | 2026-06-01 | Configure voice agent | Backend Bolna still active; no settings UI | Partial (AI-2 backend remains) | Unknown |
| Legacy kanban components | `KanbanTaskCard.tsx`, `TaskDetailModal.tsx` | `bbd9b9b5` | 2026-06 | Old task board | Replaced by Task Board V2 | Yes (PM-005) — superseded | Unknown |
| Task list-view page | `task/list-view/page.tsx` | `d0697fd3` | 2026-06 | Alternate task view | Removed; list view in kanban V2 | Optional | Unknown |
| Playwright e2e taskboard tests | `e2e/taskboard/*.spec.ts` | `5c950dd7` | 2026-07 | E2E coverage | Deleted from repo | N/A (test infra) | Internal cleanup |
| ATS kanban pipeline CSS module | `ats-pipeline-list.module.css` | — | — | Styles only | **No kanban pipeline page** ever shipped | PRD pipeline visualization not built | N/A |

---

## 19. PRD vs Current Product Differences

1. **Scope:** PRD describes 4 modules; product adds **org structure**, **activity logs**, **help & support**, **mobile app** (API version check, role-gated login), and deep **HRMS** features on employee records.
2. **ATS is multi-channel:** PRD is recruiter-operated internal ATS; product adds external jobs, referral CRM, public apply, candidate portal.
3. **Compliance model:** PRD centers binder + material-change history; product uses document verify + BGV + SOP checklists.
4. **AI claims:** PRD promises predictive/bias/adaptive AI; product has rule-based fit, Bolna verification (no auto-schedule), meeting summaries, module-builder AI.
5. **Communication:** PRD promises org storage, binders, dashboards, SSO; product delivers strong inbox/chat/dialer without enterprise comm compliance layer.
6. **Training:** PRD promises supervisor dashboard + adaptive learning; product is admin-centric with strong curriculum/attendance/evaluation.
7. **Projects:** PRD promises deliverables with hash/review; product is kanban + PM Assistant without submission workflow.

---

## 20. PRD Outdated Areas

| PRD section | Why outdated |
|-------------|--------------|
| ATS pipeline (§4) | Product has 7 application statuses, placement sub-statuses, referral lifecycle |
| Candidate terminology (§2) | UI uses Employees; APIs mix candidate/employee |
| Pre-boarding §7 | PRD: auto checklist on accept; product: empty tasks + SOP queues |
| Interview rounds §5 | PRD: Technical/Panel/HR; product: Video/In-Person/Phone |
| AI § (all modules) | PRD reads like production ML; product is selective OpenAI + Bolna + heuristics |
| Tech stack §Consolidated | Entire stack table does not match MongoDB/Express deployment |
| Communication §1 custom domain | Product uses mailbox assignment, not domain hosting |
| Training §3 supervisor | Supervisor in product = ATS compliance field, not training role |
| Projects §3 deliverables | Never built; PM module is task-centric |
| Recruiter §3 assignment | PRD: job/department; product: person-level recruiter/agent |

---

## 21. Actual Current Product Map

### Modules (as built)

```
Dashboard
├── Employee dashboard (punch, leave, tasks, projects widgets)
├── Sales-agent dashboard (referral KPIs)
└── Admin/mixed widgets

ATS (Hiring)
├── Jobs (internal) ──► Applications ──► Interviews ──► Offers ──► Placement
├── External Jobs (RapidAPI, auto-fetch, Apollo)
├── Employees (candidates + HRMS fields)
├── Referral Leads (CRM, attribution)
├── Share Candidate Form
├── Candidate portal (browse-jobs, my-applications, my-profile, courses)
├── Recruiters
├── Pre-boarding queue ──► Onboarding queue ──► Joined
└── Analytics

Communication
├── Email (Gmail/Outlook OAuth)
├── Chats (DM + group + in-app calls)
├── Meetings (internal)
├── Dialer (Plivo/Twilio)
├── Calling (unified log)
├── Recordings / transcripts
└── File manager (per-user)

Training (LMS)
├── Curriculum (categories, positions, modules, AI builder)
├── Attendance (punch, calendar, export)
├── Mentors
├── Students (roster)
├── Evaluation (quiz/essay, at-risk)
├── Analytics
└── Courses (learner portal)

Projects (PM)
├── Project list / create (AI brief)
├── My Projects / My Tasks
├── Kanban Board V2 (+ sprints)
├── PM Teams
└── PM Analytics (+ PM Assistant AI)

Organization
├── Org chart, structure, departments, directory, scenarios

Platform
├── Activity logs, notifications, settings, help, chat assistant (Sage)
└── Mobile app API (JWT, push prefs, version check)
```

### Major entities & relationships

- **User** ↔ **Role** (RBAC) ↔ permissions matrix
- **Employee** (candidate) ↔ **JobApplication** ↔ **Job**
- **Meeting** ↔ **Recording** ↔ **Summary** (interviews)
- **Offer** ↔ **Placement** (pre-board/onboard tasks, BGV, assets)
- **ReferralAttribution** ↔ referral leads pipeline
- **ExternalJob** ↔ saved jobs / auto-fetch runs
- **TrainingModule** ↔ **Student** / **Category** / **Position**
- **Project** ↔ **Task** ↔ **Sprint**; **AssignmentRun** (PM AI)
- **Conversation** ↔ **Message**; **CallRecord** (unified telephony)
- **EmailAccount** (OAuth) ↔ Gmail/Outlook sync

### User roles (observed in code)

Administrator, Recruiter, Sales Agent, Candidate, Student, Mentor, Employee (workforce), Platform Super User — with granular permission keys per module.

### Integrations (verified in code)

| Integration | Used for |
|-------------|----------|
| MongoDB | Primary datastore |
| AWS S3 | Files, recordings, exports |
| LiveKit | Video interviews, chat calls, waiting room |
| Gmail API / Microsoft Graph | Email |
| Bolna | AI voice verification (candidate + job) |
| Plivo / Twilio | Browser dialer, PSTN |
| OpenAI | Email drafts, essay grading, module AI, summaries |
| Pinecone / Qdrant | Embeddings (chatbot RAG) |
| RapidAPI | External job feeds |
| Apollo | HR contact enrichment |
| Redis / BullMQ | Summary queue |
| Expo push | Mobile notifications |
| Firebase | (frontend config present) |

### Automations (schedulers)

`meeting.scheduler`, `employee.scheduler`, `applicationVerificationCall.scheduler`, `jobVerificationCall.scheduler`, `externalJobAutoFetch.scheduler`, `attendance.scheduler`, `recording.scheduler`, `embeddingSync.scheduler`, `offer` auto-expire, `placementReminders`, SOP reminders.

---

## 22. Data / Architecture Coverage

| PRD expectation | Actual | Gap |
|-----------------|--------|-----|
| PostgreSQL relational model | MongoDB documents | Different consistency/transaction patterns |
| Append-only audit tables | `activityLog` + `placementAudit` + `referralAudit` | Not immutable/legal-hold grade |
| Vector store in Postgres | Pinecone/Qdrant optional | External dependency |
| File versioning | Timestamped S3 keys | No version chain |
| Report definitions | Ad-hoc aggregations | No `ReportDefinition` model |
| Material change history | Not modeled | PRD compliance gap |
| Communication binder | Not modeled | PRD gap |
| PM deliverables | Not modeled | PRD gap |

---

## 23. Integration Coverage

| Integration | PRD module | Implemented | E2E | Notes |
|-------------|------------|-------------|-----|-------|
| Excel import/export | ATS, Training, PM | Yes | Yes | Broader than PRD |
| Google Calendar | ATS | No | No | — |
| Outlook Calendar | ATS | No | No | Outlook = mail only |
| Google Gmail | Comm | Yes | Yes | OAuth |
| Microsoft Outlook mail | Comm | Yes | Yes | OAuth |
| LiveKit | ATS, Comm | Yes | Yes | Waiting room, egress |
| Bolna | ATS AI | Yes | Partial | No auto-schedule |
| Plivo/Twilio | Comm, ATS | Yes | Yes | Dual provider |
| OpenAI | All AI sections | Partial | Partial | Not all PRD AI items |
| Digital signature | ATS | No | No | — |
| PDF/ZIP binder | ATS, Comm | No | No | — |
| Apollo | Extra | Yes | Yes | External jobs |
| RapidAPI jobs | Extra | Yes | Yes | — |
| E-sign provider | ATS | No | No | — |
| SSO/SAML | Comm security | No | No | JWT only |
| Whisper/ASR | PRD AI | Partial | Partial | Via recording pipeline |

---

## 24. Permission / Access-Control Coverage

- **Implementation:** MongoDB `Role` collection + `permissions.js` matrix + `permission.service.js` runtime resolution.
- **ATS keys:** `ats.jobs`, `ats.candidates`, `employees.*`, `ats.interviews`, `ats.offers`, `external-jobs.*`, `share-candidate-form.*`, `candidate-sop.*`, sales-agent attribution keys.
- **Comm keys:** `emails.*`, `chats.*`, `calls.*`, `files-storage.*`, `communication.*`, directory discovery keys (Aug 2026 series).
- **Training keys:** `training.*`, `students.*`, `attendance.*`, `training.analytics`.
- **PM keys:** `projects.*`, `tasks.*`, `my-projects.read`, kanban scope for candidates.
- **Bypass:** `req.user.platformSuperUser` skips permission checks.
- **Gaps vs PRD:** No SSO/MFA; field-level encryption for SEVIS/EAD not verified; recording consent not enforced; DLP absent.

---

## 25. Major Product Gaps

### Cross-module gaps

1. **Compliance artifacts:** No PDF/ZIP binder in ATS or Communication.
2. **E-signature:** Offers sent as email PDF only.
3. **Calendar sync:** Scheduling is in-app + email invite text only.
4. **Enterprise auth:** No SSO/MFA despite PRD requirement.
5. **Custom reporting:** No report builder in ATS or comm.
6. **ATS↔Comm linking:** Calls partially linked; email/chat/files not.
7. **PM deliverables:** Entire PRD subsection missing.
8. **AI aspiration gap:** Predictive, bias, adaptive learning not built.

### Highest-risk PRD misalignment for stakeholders

Stakeholders reading the PRD may expect features that **do not exist**: compliance binder export, digital signatures, Google/Outlook calendar sync, weighted interview rubrics, bulk application moves, communication legal hold, supervisor training dashboard, PM submission review workflow.

---

## 26. Recommended PRD Updates

### Add (document what shipped)

1. External Jobs module (search, save, auto-fetch, Apollo, HR contacts).
2. Referral Leads CRM (HMAC links, sales-agent attribution, lifecycle pipeline).
3. Candidate self-service portal (public jobs, my applications, my profile, matching jobs).
4. Share-candidate-form token onboarding.
5. Public recruiter profiles.
6. Candidate SOP + offboarding SOP.
7. Actual pipeline enums (`atsPipeline.js` application, offer, placement, referral statuses).
8. LiveKit waiting room, recording/transcript pipeline.
9. Telephony stack (Plivo/Twilio dialer, click-to-call, Bolna verification) — **explicitly note auto-schedule is NOT implemented**.
10. Communication module as built (inbox, chat, dialer, calling, recordings) — not org binder/SSO.
11. Training module as built — admin-centric; note supervisor dashboard gap.
12. PM module as built — kanban + PM Assistant; **deliverables out of scope or backlog**.
13. HRMS-on-ATS (attendance, shift, week-off on employee records).
14. Org structure module.
15. RBAC permission matrix as shipped.
16. Actual tech stack (Next.js, Express, MongoDB, S3, LiveKit, etc.).

### Retain as explicit backlog

- Compliance binder PDF/ZIP (ATS + Comm).
- Material change version history.
- Digital signatures.
- Google/Outlook **calendar** API sync.
- Weighted interview rubrics.
- Bulk application stage moves.
- Custom report builder.
- AI auto-schedule after Bolna verify.
- Predictive hiring / bias detection.
- Comm legal hold, DLP, SSO/MFA.
- Training absenteeism alerts + supervisor dashboard.
- PM deliverables with hash, versions, Pass/Revise/Reject.
- Sub-tasks on tasks.

### Clarify terminology

| PRD term | Update to |
|----------|-----------|
| Candidate | Employee (UI) / Candidate (API) — document dual naming |
| Application stages (5) | List actual 7 statuses |
| Interview rounds | Meeting types: Video, In-Person, Phone |
| Intelligent matching | Skill overlap scoring (`getJobFit`) |
| AI verification calls | Bolna verify only; manual interview scheduling |
| Pre-boarding checklist | Queue + SOP + document requests |

---

## 27. Final Scorecard

### PRD coverage (all modules)

| Category | Count | % of 155 |
|----------|------:|---------:|
| 🟢 Fully implemented | 51 | 32.9% |
| 🟡 Partially implemented | 70 | 45.2% |
| ⚠️ Implemented differently | 5 | 3.2% |
| 🟠 UI / placeholder only | 2 | 1.3% |
| 🔵 Backend only | 1 | 0.6% |
| 🔴 Not implemented | 26 | 16.8% |
| **Strict coverage (🟢 only)** | **51/155** | **32.9%** |
| **Weighted coverage** | **90.25/155** | **58.2%** |

**Weighted formula:** 🟢=1.0, 🟡=0.5, ⚠️=0.75, 🟠/🔵=0.25, 🔴=0. UI-only and backend-only are **not** counted as fully implemented.

### By module (strict)

| Module | Strict % |
|--------|----------|
| ATS | 31.7% |
| Communication | 28.9% |
| Training | 41.4% |
| Projects | 32.1% |

### Product expansion scorecard (separate from PRD coverage)

| Metric | Value |
|--------|------:|
| Meaningful features beyond PRD | **~72** |
| Fully implemented extras | **~58** |
| Partial extras | **~13** |
| Placeholder extras | **1** |
| Major product areas not in PRD | External jobs, referral CRM, candidate portal, telephony,dialer, org structure, offboarding SOP, sales-agent dashboard, HRMS-on-ATS, chat assistant, mobile app gates |

**Do not add expansion features to PRD coverage percentage.**

---

## 28. Audit Methodology

### Sources

1. **PRD:** `Dharwin Business Integrated ATS_Updated.pdf` — all 4 modules, 22 pages.
2. **Codebase:** Full tree inspection of `uat.dharwin.backend/src` and `uat.dharwin.frontend/app`, `shared/`.
3. **Git history:** `git log`, `git log --follow`, `git show`, `git log --diff-filter=D` on both repos (read-only).

### Requirement decomposition

- ATS: 60 requirements (IDs ATS-*), validated against existing `ATS-PRD-AUDIT.md` and re-spot-checked.
- Communication: 38 requirements (COMM-*).
- Training: 29 requirements (TRAIN-*).
- Projects: 28 requirements (PM-*).
- **Total: 155** individually numbered requirements.

### Status rules

- 🟢 **FULLY:** Verified end-to-end (UI → API → service → model) where applicable.
- 🟡 **PARTIAL:** Meaningful implementation exists; PRD requirement not complete.
- 🟠 **UI ONLY:** Surface without backend behavior.
- 🔵 **BACKEND ONLY:** API/model without product UI.
- ⚠️ **DIFFERENT:** Material behavioral difference from PRD.
- 🔴 **MISSING:** No meaningful implementation after repo-wide search.
- ⚫ **REMOVED:** Git history shows prior implementation absent today.

### Evidence rule

Every status cites file paths, routes, or commits. Items marked "could not verify" are not claimed as implemented.

### Limitations

- **No runtime testing** — behavior depends on `.env` (Bolna, LiveKit, Redis, Apollo, OAuth tokens).
- **No production DB inspection** — model/schema evidence only.
- **Client request attribution** — sparse explicit evidence; most changes classified internal or unknown.
- **Mobile app** (`Dharwin App` workspace) — not fully audited; backend mobile endpoints noted (`/v1/app/version`, push prefs).
- **Dharwin App** folder excluded from page inventory except backend mobile API references.

### Quality checklist

- [x] Every PRD requirement audited (155/155)
- [x] Every major current feature considered
- [x] Extra functionality identified separately
- [x] Missing, partial, UI-only, backend-only, different identified
- [x] Git history reviewed for major pages and removals
- [x] Client-request evidence separated from assumptions
- [x] PRD outdated areas identified
- [x] Current product map created
- [x] Evidence/file paths provided
- [x] No code modified
- [x] PRD coverage excludes extra functionality

---

## Appendix A — Answers to the 15 final questions

1. **What did the PRD ask us to build?** Four integrated modules (ATS, Communication, Training, Projects) with AI, compliance, binders, e-sign, calendar sync, rubrics, dashboards, and a TypeScript/Postgres/NestJS stack.

2. **What have we actually built?** A MongoDB/Express/Next.js platform with strong ATS+hiring ops, comms (email/chat/dialer/video), training LMS, PM kanban — plus substantial extras (external jobs, referral CRM, candidate portal, org structure, HRMS fields).

3. **Fully implemented PRD features?** 51 of 155 (32.9%) — see Section 6.

4. **Partially implemented?** 70 requirements — see Section 7.

5. **Missing?** 26 requirements — see Section 8 (binder, e-sign, calendar, rubrics, bulk moves, custom reports, predictive/bias AI, comm binders/dashboards/SSO, deliverables, supervisor training dashboard, etc.).

6. **UI/placeholder only?** COMM-CHAT-005 mentions; public captcha stub (ATS extra).

7. **Backend only?** Placement audit API; chat pin preferences.

8. **Implemented differently?** Pipeline stages, AI matching, email “custom domain”, file storage scope, kanban columns — Section 11.

9. **Built beyond PRD?** ~72 features — Section 12.

10. **Previously built then changed/removed?** Job Applications page, combined pre-boarding page, Bolna settings UI, legacy kanban — Sections 17–18.

11. **Client-request traced changes?** One confirmed (Plivo migration script); most changes lack client attribution — Section 16.

12. **Internal/engineering changes?** Majority — pagination, RBAC hardening, UI polish, consolidations.

13. **PRD outdated areas?** Section 20 — pipeline, terminology, AI claims, tech stack, compliance model.

14. **Current product shape?** Section 21 product map.

15. **Next PRD should contain?** Section 26 — document shipped extras + explicit backlog.

---

## Appendix B — Key file index

**Backend:** `src/constants/atsPipeline.js`, `src/routes/v1/{job,employee,jobApplication,meeting,offer,placement,atsAnalytics,externalJob,bolna,livekit,recording,email,outlook,chat,communication,fileStorage,project,task,pmAssistant,trainingModule,attendance,evaluation,analytics}.route.js`, `src/services/{jobApplication,meeting,offer,placement,referralLeads,externalJob,email,chat,communication,pmAssistant,trainingModule,attendance,evaluation,analytics}.service.js`

**Frontend:** `shared/layout-components/sidebar/nav.tsx`, `app/(components)/(contentlayout)/{ats,communication,training,task,apps/projects,project-management,organization,logs}/**`, `shared/lib/api/*.ts`

**Prior audit (Module 1 detail):** `ATS-PRD-AUDIT.md`

---

*End of audit. Runtime behavior may differ based on environment configuration, schedulers, and external service credentials — not exercised during this review.*
