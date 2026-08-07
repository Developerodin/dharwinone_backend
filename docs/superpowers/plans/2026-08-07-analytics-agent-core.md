# Chatbot Analytics Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps for tracking.

**Goal:** Authoritative chatbot analytics without LLM invented counts; correct population (Employee vs ATS referral candidate vs Student LMS).

**Architecture:** Program of gated epics (A→G). Approach C per epic. Dates via `phraseToDateWindow` → `resolveDateWindow`. RBAC parity with HTTP APIs.

**Tech Stack:** Node ESM, Mongoose, chatAssistant, `referralLeads.service`, `orgStructure.service`, `attendanceAggregator`, `meeting.model`, `StudentCourseProgress`, `node:test`.

**Spec:** [../specs/2026-08-07-analytics-agent-core-design.md](../specs/2026-08-07-analytics-agent-core-design.md)

## Global Constraints

- Never answer ATS tunnel counts from Employee resign/join filters.
- Hand-off to employee tools only when User has **Employee** role.
- “Joined this month” → clarify employment vs placement vs Hired.
- Keep `resolveDateWindow` inclusive UTC EOD.
- Interview “by employee name” = interviewer/recruiter, not candidate.
- Training epic blocked on FK discovery (StudentCourseProgress).
- Prefer wrapping `getReferralLeadsStats` / orgStructure APIs over duplicate aggregations.
- TDD; Windows-safe test registration.

---

## Epic A — MVP (implement first)

### A0 Visibility prerequisite
- [ ] Land `employeeOwnerQuery`; no disabled widen
- [ ] Tests; commit

### A1 phraseToDateWindow
- [ ] TDD during/before July + clarification
- [ ] Implement; commit

### A2 Clarification + memory
- [ ] Wire NEEDS_TIME_WINDOW-style clarify; store window
- [ ] Commit

### A3 employeeEmploymentFilter + employee_analytics
- [ ] Resign/join/headcount + paid/unpaid for Employee-role only
- [ ] Refactor fetch_employees; AUTHORITATIVE_COUNT
- [ ] Tests; commit

### A4 Router guards
- [ ] Block funnel/refer-lead language from employee_analytics
- [ ] Clarify “joined” when ambiguous
- [ ] Commit

**Exit gate:** Manual July resign before/during; paid/unpaid; funnel question does not use employee resign set.

---

## Epic B — Attendance ops (after A)

- [ ] Avg daily Present helper + facts tags
- [ ] Leave + backdated authoritative window counts
- [ ] Week-off / groups routing via overview
- [ ] Tests; commit

---

## Epic C — Candidate hiring tunnel (after A)

- [ ] Spike: map chatbot args → `buildReferralLeadsMatch` / `getReferralLeadsStats`
- [ ] Tool wrapping referral lead stats + stage breakdown aligned with Refer Leads UI
- [ ] Include applications/interviews/offers/placements as labeled buckets with provenance
- [ ] Pre-boarding concurrent (not fake linear APPLICATION status)
- [ ] RBAC `referralLeads.read` (or equivalent)
- [ ] Tests; commit

---

## Epic D — Interviews (after A)

- [ ] `fetch_interviews` / analytics on `meeting.model` interview fields
- [ ] Filters: date window, interviewer employee name, candidate name, status/result
- [ ] Do not use internalMeeting for this epic
- [ ] Tests; commit

---

## Epic E — Meetings (after D or parallel)

- [ ] Harden non-interview meetings path; type filter so interviews don’t leak
- [ ] Counts by date/participant/status
- [ ] Tests; commit

---

## Epic F — Training (spike then build)

- [ ] Spike: does StudentCourseProgress link to ATS candidate, Student role, or Employee?
- [ ] Only then: list courses for person X + counts
- [ ] Tests; commit

---

## Epic G — Org chart (after A)

- [ ] Wrap `orgStructure.service` for dept/supervisor/employee/unassigned counts
- [ ] Lock unassigned definition to match UI
- [ ] RBAC; tests; commit

---

## Out of scope

Charts, free Mongo, RAG, workflows, deep why-reasoning, cost-per-hire.
