# Attendance System Audit: Student, Candidate, Agent

**Date:** 2025-03-13  
**Scope:** Backend (DB, API), Frontend (page, API client, permissions), and role-based behaviour for **Student**, **Candidate**, and **Agent**.

---

## 1. Role Definitions & Identity

| Role       | Has Student profile? | GET `/training/attendance/me` returns | Uses which APIs? |
|-----------|----------------------|---------------------------------------|-------------------|
| **Student**   | Yes (Training student) | `{ type: 'student', id: studentId, user, weekOff?, shift?, ... }` | Student-based: `/status/:studentId`, `/punch-in/:studentId`, `/student/:studentId`, `/statistics/:studentId` |
| **Candidate** | Yes or No             | If has Student → same as Student. If no Student → `{ type: 'user', id: userId, user }` | Same as above: student-based if Student exists, else user-based `/me` |
| **Agent**     | No (by design)       | `{ type: 'user', id: userId, user }`  | User-based only: `/status/me`, `/punch-in/me`, `/punch-out/me`, `/student/me`, `/statistics/me` |
| **Administrator** | N/A              | `404` (no self-attendance)            | Uses "Track Attendance" for others only |

- **Admin detection** uses **only `roleIds`** (RBAC). Users with legacy `role: 'admin'` but no Administrator in `roleIds` are **not** treated as admin and get user identity if they have no Student.
- **No Student is auto-created** for Agents or Candidates in `getAttendanceIdentity`; Candidates without a Student use user-based attendance.

---

## 2. Backend Audit

### 2.1 Identity & Access

- **`student.service.js` → `getAttendanceIdentity(user)`**
  - Returns `null` only when: no userId, user not found, or **admin (roleIds contain Administrator/admin Role)**.
  - If user has a **Student** → returns that Student (with `type: 'student'` set in controller).
  - If user has **no Student** → returns `{ type: 'user', id: userId, user: { id, name, email } }`.
  - Admin check: **only** `roleIds`; legacy `role` field is **not** used.

- **`attendance.controller.js` → `getMyStudentForAttendance`**
  - Sends **404** only when `identity === null` (admin).
  - Sends **200** with identity (student or user) otherwise.

- **`requireMeIdentity`** (used by `/me` punch/status/list/statistics)
  - Allows only when `identity.type === 'user'` (no Student).
  - Students/Candidates with a Student must use `/:studentId` routes; they get **403** if they call `/me` endpoints.

### 2.2 Routes (attendance.route.js)

| Route | Auth | Extra | Who uses it |
|-------|------|--------|-------------|
| `GET /me` | auth() | — | All non-admin (Student, Candidate, Agent) to get identity |
| `POST /punch-in/me`, `POST /punch-out/me` | auth() | rate limit | Agent (and Candidate without Student) |
| `GET /status/me`, `GET /student/me`, `GET /statistics/me` | auth() | — | Agent (and Candidate without Student) |
| `GET /track`, `GET /track/history` | auth() | **students.manage** | Admin only |
| `POST/DELETE /holidays`, `POST /leave`, `POST /student/:studentId/regularize` | auth() | **attendance.assign** | Admin / agents with permission |
| `router.use(requireAttendanceAccess)` then `POST /punch-in/:studentId`, etc. | auth() | studentId in path; must be owner or students.read/students.manage | Student / Candidate (with Student) / Admin punching for others |

### 2.3 Services (attendance.service.js)

- **Student-based:** `punchIn`, `punchOut`, `getCurrentPunchStatus`, `listByStudent`, `getStatistics` (filter by `student`).
- **User-based:** `punchInByUser`, `punchOutByUser`, `getCurrentPunchStatusByUser`, `listByUser`, `getStatisticsByUser` (filter by `user`).
- **Model:** `Attendance` has optional `student` and `user`; validation ensures exactly one of them is set.

### 2.4 Backdated Attendance Requests

- **Student-based:** `POST/GET /backdated-attendance-requests/student/:studentId` — create/list by studentId (Student / Candidate with Student).
- **User-based:** `POST/GET /backdated-attendance-requests/me` — create/list by current user (Agent / Candidate without Student).
- **BackdatedAttendanceRequest** model supports both `student` and `user`/`userEmail` for user-based requests.
- Approve/Reject/Update require **students.manage**; Cancel is allowed for the requester.

---

## 3. Frontend Audit

### 3.1 Permission & Route Guard

- **Path:** `/training/attendance` requires permission prefix **`training.attendance:`** (e.g. `training.attendance:view`).
- **PermissionGuard** redirects if the user has no matching permission; Student, Candidate, and Agent roles that have this permission can open the page.

### 3.2 Attendance Page (`training/attendance/page.tsx`)

- **Identity:** Calls `getMyStudentForAttendance()` when `user` (from `useAuth()`) is set; sets `myStudentId` from `identity.id ?? identity._id` and `isUserBased = (identity.type === 'user')`.
- **Status:** `fetchStatus(id)` uses `isUserBased ? getPunchInOutStatusMe() : getPunchInOutStatus(id)`.
- **List:** `fetchList(id, params)` uses `isUserBased ? listAttendanceMe(params) : listAttendance(id, params)`.
- **Punch In/Out:** Uses `punchInAttendanceMe` / `punchOutAttendanceMe` when `isUserBased`, else `punchInAttendance(myStudentId)` / `punchOutAttendance(myStudentId)`.
- **Statistics:** Uses `getAttendanceStatisticsMe()` when `isUserBased`, else `getAttendanceStatistics(myStudentId)`.
- **Backdated request:** Uses `createBackdatedAttendanceRequestMe(payload)` when `isUserBased`, else `createBackdatedAttendanceRequest(myStudentId, payload)`.
- **Track list / History:** Only when `canTrackAll` (users with **students.manage**); Agents without that permission only see their own punch UI.
- **“No student profile found”** shows when: `!canPunch && !loadingStudent && !canTrackAll && trackList.length === 0 && !trackListLoading` (i.e. no identity and no track list). **404** from `/me` is treated as “no identity” (admin); **401/5xx** are thrown and show session/error message.

### 3.3 Dashboard (`dashboard/page.tsx`)

- Loads `getMyStudentForAttendance()` and sets `attendanceStudent`.
- **Status:** `identity.type === 'user'` → `getPunchInOutStatusMe()`, else `getPunchInOutStatus(identity.id)`.
- **Punch:** `identity.type === 'user'` → `punchInAttendanceMe` / `punchOutAttendanceMe` and `getPunchInOutStatusMe()`; else student-based punch and `getPunchInOutStatus(identity.id)`.

### 3.4 API Client (`shared/lib/api/attendance.ts`)

- **getMyStudentForAttendance():** Returns `null` only on **404**; throws on 401/5xx.
- **Me APIs:** `punchInAttendanceMe`, `punchOutAttendanceMe`, `getPunchInOutStatusMe`, `listAttendanceMe`, `getAttendanceStatisticsMe` map to `/me` endpoints.
- **Student APIs:** `getPunchInOutStatus(id)`, `punchInAttendance(id)`, `punchOutAttendance(id)`, `listAttendance(id)`, `getAttendanceStatistics(id)` map to `/:studentId` endpoints.

---

## 4. Test Matrix (Manual / Integration)

### 4.1 GET `/v1/training/attendance/me`

| User type        | Has Student? | Expected response |
|------------------|-------------|-------------------|
| Administrator    | N/A         | **404** (admins don’t fill self-attendance) |
| Student (role)   | Yes         | **200** `{ type: 'student', id: studentId, user, weekOff?, shift?, ... }` |
| Candidate        | Yes         | **200** same as Student |
| Candidate        | No          | **200** `{ type: 'user', id: userId, user }` |
| Agent            | No          | **200** `{ type: 'user', id: userId, user }` |

### 4.2 Punch In / Out

| Role       | Identity type | Punch In | Punch Out | Status |
|-----------|----------------|----------|-----------|--------|
| Student   | student        | `POST /punch-in/:studentId` | `POST /punch-out/:studentId` | `GET /status/:studentId` |
| Candidate | student        | Same as Student | Same | Same |
| Candidate | user           | `POST /punch-in/me` | `POST /punch-out/me` | `GET /status/me` |
| Agent     | user           | `POST /punch-in/me` | `POST /punch-out/me` | `GET /status/me` |

- **403** expected if a user with a Student calls `/punch-in/me` (requireMeIdentity requires `type === 'user'`).

### 4.3 List & Statistics

| Identity type | List | Statistics |
|---------------|------|-------------|
| student       | `GET /student/:studentId` | `GET /statistics/:studentId` |
| user          | `GET /student/me`        | `GET /statistics/me`        |

### 4.4 Backdated Requests

| Identity type | Create | List (own) |
|---------------|--------|------------|
| student       | `POST /backdated-attendance-requests/student/:studentId` | `GET /backdated-attendance-requests/student/:studentId` |
| user          | `POST /backdated-attendance-requests/me`                 | `GET /backdated-attendance-requests/me`                 |

### 4.5 Track List & History (Admin)

- **GET /track**, **GET /track/history**: Require **students.manage**; Agents/Candidates without it get **403**.
- Frontend shows “Track” view only when `canTrackAll` (resolved from roles with students.manage).

### 4.6 Dashboard Punch Widget

- **Student / Candidate (with Student):** Status and punch use studentId APIs.
- **Agent / Candidate (no Student):** Status and punch use `/me` APIs.
- **Administrator:** No identity (404) → no punch widget (or widget hidden when no identity).

---

## 5. Manual Test Checklist

Use this checklist to verify behaviour for **Student**, **Candidate**, and **Agent** in the browser and (optionally) via API client (e.g. Postman).

### 5.1 Student (user with Training Student profile)

- [ ] **Login** as a user who has a Student profile (e.g. Training > Students list).
- [ ] **Open** Training Management > Attendance Tracking.
- [ ] **Expect:** Page loads with punch In/Out, calendar/list, and statistics (no “No student profile found”).
- [ ] **Punch In** → status shows “Punched in”, elapsed time updates.
- [ ] **Punch Out** → status shows “Punched out”.
- [ ] **Calendar/List** shows own records; **Statistics** show totals.
- [ ] **Request Backdated Attendance** → submit with past dates → success; list shows pending request (if UI supports it).
- [ ] **Dashboard** (if visible) punch widget works (punch in/out, status).
- [ ] **API:** `GET /v1/training/attendance/me` returns **200** with `type: 'student'` and `id: <studentId>`.

### 5.2 Candidate with Student profile

- [ ] **Login** as a Candidate who has a Student profile.
- [ ] Same as **Student** above: page loads, punch in/out, list, statistics, backdated request, dashboard widget.
- [ ] **API:** `GET /v1/training/attendance/me` returns **200** with `type: 'student'`.

### 5.3 Candidate without Student profile

- [ ] **Login** as a Candidate who does **not** have a Student profile.
- [ ] **Open** Attendance Tracking.
- [ ] **Expect:** Page loads with punch In/Out and list/statistics (user-based; no “No student profile found”).
- [ ] **Punch In / Punch Out** work; list and statistics show data.
- [ ] **Request Backdated Attendance** works.
- [ ] **API:** `GET /v1/training/attendance/me` returns **200** with `type: 'user'` and `id: <userId>`.

### 5.4 Agent (no Student profile)

- [ ] **Login** as an Agent (role with no Student).
- [ ] **Open** Attendance Tracking.
- [ ] **Expect:** Page loads with punch In/Out and list/statistics (no “No student profile found”).
- [ ] **Punch In / Punch Out** work.
- [ ] **List** and **Statistics** show own records only.
- [ ] **Request Backdated Attendance** works.
- [ ] **Track list / Track history** are **not** visible (or show empty/403) unless Agent has **students.manage**.
- [ ] **Dashboard** punch widget works.
- [ ] **API:** `GET /v1/training/attendance/me` returns **200** with `type: 'user'`; `/punch-in/me`, `/status/me`, etc. return **200**.

### 5.5 Administrator

- [ ] **Login** as Administrator (roleIds include Administrator role).
- [ ] **Open** Attendance Tracking (if permitted).
- [ ] **Expect:** Either “No student profile found” (no self-attendance) or redirect; **Track** view visible if user has students.manage.
- [ ] **API:** `GET /v1/training/attendance/me` returns **404** with message about admins not filling self-attendance.

### 5.6 Permissions

- [ ] User **without** `training.attendance:*` cannot open `/training/attendance` (redirect or 403).
- [ ] User with **students.manage** sees **Track** tab and track list/history; others do not (or get 403 on /track).

---

## 6. Summary

- **Student:** Always has a Student profile; uses only student-based routes; can punch, view list, statistics, and submit backdated requests by studentId.
- **Candidate:** If has Student → same as Student. If no Student → uses user-based `/me` routes (same as Agent); no Student is auto-created.
- **Agent:** No Student; uses only `/me` routes for punch, status, list, statistics, and backdated requests; **403** on `/me` if they somehow have a Student.
- **Administrator:** GET `/me` returns **404**; uses Track Attendance (students.manage) for others; no self-attendance.
- **Admin detection** is RBAC-only (`roleIds`); legacy `role` field is not used for attendance identity.
- Frontend (attendance page and dashboard) branches correctly on `identity.type === 'user'` for all attendance and backdated APIs.

### Automated tests

- **`tests/integration/attendance.test.js`** – Integration tests for `GET /v1/training/attendance/me` (401 without token, 200 with token and user identity). Run after fixing Jest/ESM if needed: `npm test -- tests/integration/attendance.test.js`
