# Chatbot Analytics Program — Design Spec

**Date:** 2026-08-07 (adversarial rewrite #2)  
**Status:** Corrected program charter  
**Repo:** `uat.dharwin.backend`  
**Plan:** `docs/superpowers/plans/2026-08-07-analytics-agent-core.md`

## 1. Objective (re-derived)

Stop the LLM inventing counts. Every quantitative answer must come from a tool that queries the correct **population** and returns `AUTHORITATIVE_COUNT` + provenance.

Original failure: resign date-range counts. Expanded ask: candidate hiring tunnel (not employees) plus interviews, training, meetings, org, paid/unpaid, leave/backdated/week-off/groups.

## 2. Populations (hard rules)

| Population | Identity in code | Chatbot must use |
|------------|------------------|------------------|
| **Employee** | User with Employee role + profile in `candidates` collection via owner | `employee_*` tools only |
| **ATS candidate / referral lead** | Same profiles viewed through **referral leads** / applications / placements — **before** Employee-role hand-off | `referralLeads` + ATS tools only |
| **Student (LMS)** | StudentCourseProgress / training enrollments | Training tools — **not assumed = ATS candidate** until model link verified |

**Hand-off (not a single flag):** Application `Hired`, Placement `Joined`, and User role **Employee** are three different events. Spec must not say “Hired/Joined → employee” as one step. Chatbot hand-off rule: **Employee-role tools only when User has Employee role**; until then ATS/referral tools.

**“Joined this month” ambiguity:** Always clarify employment join (`joiningDate` + Employee role) vs placement `Joined` vs application `Hired`.

## 3. Program shape (not one epic)

This is a **program**. Ship as separate epics. Do not implement P0–P6 as one PR train without gates.

| Epic | Name | Outcome |
|------|------|---------|
| **A (MVP)** | Date phrases + employee analytics | July resign class fixed; paid/unpaid employee counts |
| **B** | Attendance ops | Avg daily present; leave; backdated; week-off/groups routing |
| **C** | Candidate hiring tunnel | Refer-lead → onboarding snapshot via `referralLeads.service` + ATS models |
| **D** | Interviews | By date, **interviewer (employee) name**, candidate, status/result |
| **E** | Meetings | Internal/general meetings (separate from interview meetings) |
| **F** | Training | Course assignments — confirm Student vs ATS link first |
| **G** | Org chart | Depts, supervisors, headcounts, unassigned — via `orgStructure.service` |

Epic A is the only required start. B–G are backlog epics with the same Approach C pattern.

## 4. Approach C (all epics)

- List tool vs analytics/count tool share filters  
- `phraseToDateWindow` / `temporalResolver` → existing `resolveDateWindow` (inclusive UTC EOD)  
- Clarify before-vs-during month when the user asks that contrast; otherwise prefer temporal rules below  
- RBAC: every new tool path must honor the same permissions as the HTTP API (`referralLeads.read`, org structure, training, etc.)  
- No free Mongo, charts, RAG, workflows in this program  

### Phase 0 — Temporal reasoning / date resolver

Natural-language periods must not invent a distant year (e.g. Aug 2026 + “July” must not become July 2023).

| Rule | Behavior |
|------|----------|
| **Month, no year** | Most recent occurrence of that month relative to `now` (Aug 2026 + “july” → July 2026; Jan 2026 + “december” → Dec 2025). |
| **DB multi-year** | For resign/join “in July”, probe Employee `resignDate`/`joiningDate` by month (scoped via `employeeOwnerQuery`). If DISTINCT years with data > 1 → natural clarify with counts, most recent first (“I found resignation records in multiple Julys. Did you mean July 2026 (5) or July 2025 (6)?”). |
| **Single data year** | Auto-resolve to that year (data wins). Zero years → calendar most-recent (empty result OK). |
| **Memory** | After “resigned in 2026”, follow-up “only July” → July 2026 via `ConversationMemory` (`lastYear` / `lastFromDate`). |
| **Vague (v1)** | “financial year”, “recent”, “old employees”, “new joiners” → `needsClarification` with natural options. “last quarter” → most recent completed calendar quarter. |
| **Confidence** | ≥90% and no multi-year conflict → auto; multi-year data → ask regardless; &lt;70% ambiguous → ask. |

Keep inclusive UTC EOD semantics from `resolveDateWindow`.  

## 5. Epic C — Candidate hiring tunnel (corrected)

**Entry:** job share / share-candidate form → **referral leads** (`referralLeads.service.js`: `listReferralLeads`, `getReferralLeadsStats`, pipeline sync) — **not** “Candidate role ≈ refer leads” as a synonym.

**Stages (data-backed, may be parallel):**

- Referral lead effective status (service pipeline / attribution)  
- Job application (`APPLICATION_STATUSES`)  
- Interview meeting (`meeting.model`: `candidate`, `recruiter`, `interviewResult`, `interviewType`)  
- Offer (`OFFER_STATUSES`)  
- Placement (`PLACEMENT_STATUSES` incl. Onboarding, Joined)  
- Pre-boarding (docs/checklist permissions — **not** a linear APPLICATION_STATUSES step; often concurrent with placement Pending)

**Chatbot:** Prefer wrapping `getReferralLeadsStats` / lead list match builders over inventing a new funnel aggregator that disagrees with the Refer Leads UI.

## 6. Epic D — Interviews (corrected)

User ask: detail by **date**, by **employee name**, by **interview status**.

- **Employee name** = interviewer / recruiter / assigned agent on `meeting` (not the candidate).  
- **Candidate** is a separate filter.  
- Source: `meeting.model.js` interview fields — not `internalMeeting.model.js`.  
- Status = meeting lifecycle + `interviewResult` (`pending|selected|rejected`).

## 7. Epic E — Meetings

- `internalMeeting` / general meetings ≠ interview schedule meetings.  
- Spec must keep tools or type filters distinct to avoid “meetings on Monday” returning only interviews or vice versa.

## 8. Epic F — Training

- Model found: `StudentCourseProgress` (enrolled/in-progress/completed/dropped).  
- **Unsupported** that these attach to ATS referral candidates. Discovery spike required: student User role vs candidate id.  
- Do not promise “courses for ATS candidate X” until the FK is proven.

## 9. Epic G — Org

- Use `orgStructure.service` (`buildTree`, `queryEmployeeDirectory`, etc.).  
- Define **unassigned**: no `departmentId` / no org unit membership — pick one and match UI.  
- Supervisor queries must use org graph, not free-text `supervisorName` on profile alone (unless UI does that — verify).

## 10. Epic A — Employees (MVP detail)

- Visibility: `employeeOwnerQuery` (no disabled widen).  
- `employee_analytics` for resign/join/headcount/paid-unpaid (`compensationType` on profile).  
- Note: `compensationType` also appears in candidate/offer flows — analytics filter must scope to **Employee-role owners** only.  
- Date phrases + clarification.

## 11. Epic B — Attendance ops

- Avg daily Present from `aggregateOrgAttendance`.  
- Leave + backdated existing fetches hardened.  
- Week-off / groups via `fetch_employee_overview`.  

## 12. Success criteria (MVP Epic A only)

1. Before/during July resign: clarify when asked that contrast; bare/in-July uses temporal resolver (calendar most-recent + DB multi-year clarify) and matches Employees visibility.
2. Paid vs unpaid employee counts exclude non-Employee roles.
3. No hiring-tunnel question answered from employee resign filters.

Epic B–G each get their own success checklist at epic kickoff.

## 13. Explicit omissions fixed from prior spec

- Prior: one mega-phase P0–P6 → **program with gated epics**  
- Prior: Candidate role = refer leads → **use referralLeads service**  
- Prior: Hired/Joined = employee → **Employee role is hand-off**  
- Prior: interview “by person” vague → **interviewer employee vs candidate**  
- Prior: training for candidate assumed → **StudentCourseProgress discovery**  
- Prior: no RBAC → **API permission parity required**  
- Prior: “joined” routing → **must clarify**  
