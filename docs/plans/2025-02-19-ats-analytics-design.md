# ATS Analytics - Design Document

**Date:** 2025-02-19  
**Status:** Approved (Brainstorming)  
**Scope:** Moderate + Improvements (Export, Drill-down, Period Comparison)

---

## 1. Purpose

Provide recruitment and hiring insights to ATS users. Admins see org-wide data; recruiters see only their own activity, candidates, and applications.

---

## 2. Architecture & Data Scoping

- **Endpoint:** `GET /v1/ats/analytics`
- **Auth:** Required. Permission: `ats.analytics:view` or admin.
- **Scoping:**
  - **Admin:** No filter — org-wide aggregates (all jobs, candidates, applications).
  - **Recruiter:** Filter by `recruiterId` (current user):
    - Candidates: `assignedRecruiter = recruiterId`
    - Jobs: `createdBy = recruiterId`
    - JobApplications: applications for jobs created by recruiter OR for candidates assigned to recruiter
    - RecruiterActivityLog: `recruiter = recruiterId` (existing filter)

- **Query params:** `range` (7d | 30d | 3m | 12m), optional `startDate`, `endDate`.

---

## 3. Response Shape

```ts
{
  totals: { totalCandidates, totalJobs, activeJobs, totalApplications, totalRecruiters, hiredCount, avgProfileCompletion, conversionRate }
  previousPeriod?: { applications, hired, periodLabel }  // for comparison
  applicationsOverTime: { period, count }[]
  applicationFunnel: { status, count }[]
  jobStatusBreakdown: { status, count }[]
  applicationStatusBreakdown: { status, count }[]
  recruiterActivityStats: { jobPostingsCreated, candidatesScreened, interviewsScheduled, notesAdded, feedbackAdded, total }
  recruiterActivitySummary: { recruiter, activities, totalActivities }[]  // leaderboard
  range: string | null
}
```

---

## 4. UI Layout

1. **Header:** Date range selector (All time, 7d, 30d, 3m, 12m)
2. **Row 1 – Summary cards:** Total Candidates, Total Jobs, Active Jobs, Total Applications, Hired, Recruiters, Conversion Rate. Each card shows a small delta vs previous period when `range` is set.
3. **Row 2:** Applications over time (line) | Application funnel (horizontal bar)
4. **Row 3:** Job status (donut) | Application status (donut)
5. **Row 4:** Recruiter activity by type (bar) | Recruiter leaderboard (table)
6. **Actions:** Export to CSV

---

## 5. Drill-down

- Clicking a chart segment (e.g. "Applied" in application status) opens a modal with a paginated table of matching records (candidate name, job, date).
- "View all" link in modal navigates to the filtered list page (future enhancement if list filters support it).

---

## 6. Export

- CSV with summary totals and chart data (aligned with Training analytics export structure).
- Filename: `ats-analytics-YYYY-MM-DD.csv`

---

## 7. Period Comparison

- When `range` is set (7d, 30d, etc.), compute the immediately preceding period of the same length.
- Return `previousPeriod` in the response.
- Summary cards show small badges: e.g. "+12 vs prev" or "-3 vs prev".

---

## 8. Files to Create/Modify

| Action | File |
|--------|------|
| Create | `uat.dharwin.backend/src/services/atsAnalytics.service.js` |
| Create | `uat.dharwin.backend/src/controllers/atsAnalytics.controller.js` |
| Create | `uat.dharwin.backend/src/validations/atsAnalytics.validation.js` |
| Create | `uat.dharwin.backend/src/routes/v1/atsAnalytics.route.js` |
| Modify | `uat.dharwin.backend/src/routes/v1/index.js` |
| Create | `uat.dharwin.frontend/shared/lib/api/atsAnalytics.ts` |
| Modify | `uat.dharwin.frontend/app/(components)/(contentlayout)/ats/analytics/page.tsx` |
| Create | `uat.dharwin.frontend/app/(components)/(contentlayout)/ats/analytics/DrillDownModal.tsx` (optional component) |

---

## 9. Out of Scope (First Release)

- Top jobs by applications
- Profile completion distribution
- Hires by job table
- Job type distribution
- Jobs created over time
