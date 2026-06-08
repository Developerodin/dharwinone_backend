<claude-mem-context>
# Memory Context

# [uat.dharwin.backend] recent context, 2026-06-08 11:15am GMT+5:30

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (27,210t read) | 2,511,253t work | 99% savings

### May 20, 2026
S579 Remove all scripts and tests from uat.dharwin.backend, merge all feature branches into main, delete merged branches, leave unmapped members as-is (May 20, 4:44 PM)
S578 Remove all scripts and tests from uat.dharwin.backend codebase, merge all feature branches into main (leave unmapped members as-is) (May 20, 4:44 PM)
S580 Remove all scripts and tests, merge all branches into main — executed across both uat.dharwin.backend and uat.dharwin.frontend (May 20, 4:46 PM)
S581 Fix Vercel production build failure on dharwinfrontend caused by impure CSS Modules selectors in the kanban board feature (May 20, 4:49 PM)
S582 Fix and deploy resolution for Vercel production build failure on dharwinfrontend — CSS Modules purity violation in kanban board styles (May 20, 4:59 PM)
### May 28, 2026
3484 1:57p 🔵 permissions.js: Dead Alias Entries Confirmed at Lines 82-95, permissionAliases Already Named-Exported
3486 1:58p 🔵 Full Baseline Audit: requireAnyOfPermissions Already Imported, bustRoleRegistry Correctly Exported, All Files Match Plan Assumptions
3487 " 🔵 requireAnyOfPermissions Goes Through Alias Expansion — employees.manage Has No Alias Entry, Checks Derived Key Directly
3488 " 🔵 bustRoleRegistry Is Synchronous — Migration await Call Is Harmless No-Op
3493 2:06p 🟣 ATS Employees Permission Row — Full Implementation Plan (PR1)
3494 " ⚖️ Permission Normalization: Only Mirror Strings Normalized, Source Strings Preserved Verbatim
3495 " ⚖️ Backend-Frontend Permission Parity: Frontend Uses Raw Manage-Action Check, Not Derived Keys
3496 " ⚖️ Commit Safety Order Enforced: Helpers Before Route Gates Before Alias Deletion
3499 2:08p 🔵 Code Audit: Verified Current State of All Files Before PR1 Implementation
3500 " 🔵 requireAnyOfPermissions Expands Arguments Through permissionAliases — Broader Grant Than Intended
3501 " 🔵 Role Model Post-UpdateOne Hook Will Bust Registry Cache on Every Migration Write
### Jun 1, 2026
4002 2:59p ⚖️ Activity Log Filter Redesign — Technical Review Spec
4003 3:01p 🔵 activityLog.service.js — buildActivityLogMongoFilter: exact code structure confirmed
4004 " 🔵 user.model.js — name field has NO index; email has unique index
4005 " 🔵 config/activityLog.js — spec catalog sync is incomplete: misses supportCamera.invite and settings.bolnaCandidateAgent.update
4006 " 🔵 activityLog controller: export route gated by requireDesignatedSuperadmin, list route by requireActivityLogsListAccess
4007 " 🔵 activityLog.model.js — schema and index structure confirmed
4016 3:13p 🔵 Activity Log Service Architecture — Query Filter Pipeline
4017 " ⚖️ Activity Log UI Redesign — Search-First Filter Bar with Name/Email Lookup
4018 " 🔵 Timezone Bug Risk in Frontend Date Preset Calculation
4019 3:15p 🔵 activityLog.js Config Already Contains All Proposed New Actions and Entity Types
4020 " 🔵 User Model Has No Index on name or email for Regex Lookup — Full Collection Scan Risk
4021 " 🔵 Existing q Block in activityLog.service.js Already Implements IP Regex and $and Composition
4022 " 🔵 Node:test ESM Import Pattern Confirmed from Existing Test Files
4023 " 🔵 Activity Log Access Control: Non-Privileged Self-Actor Path Exists in Middleware
4024 " 🔵 lean-ctx Shell Commands Blocked by Policy on Windows — Fallback to ctx_read Tool Used
4062 3:55p 🔵 RBAC Permission Matrix Audit — 16 Claimed Dead/UI-Only Rows in HR Backend
4067 3:56p 🔵 RBAC Audit Verdict: 7 of 16 Claimed Dead Rows Refuted, 9 Confirmed — Key False Positives Found
4086 4:18p 🔵 RBAC Permission Matrix Security Audit Initiated — HR Backend
4092 4:21p 🟣 job-templates.* Permission Keys Wired to /jobs/templates Routes
4093 " 🔵 Administrator Name-Bypass Inconsistency: requireExternalJobsAccess vs Others
4094 " 🔵 Cross-Scope Privilege Escalation via interviews.* Alias Granting candidates.read, jobs.read, users.read
4095 " 🔵 uploads.document Alias Bundles 18 Distinct manage Keys — Any Single Manage Permission Grants S3 Upload
4096 " 🔵 recruiters.update Permission Key Used in Routes Has No Alias Entry — May Be Wrong-Key
4097 " 🟣 CI Permission Matrix Enforcement Guard Added — scripts/assert-permission-matrix-enforced.mjs
4098 " 🔵 deriveApiPermissions Multi-Dot Key Edge Case: settings.users.impersonate Produces users.impersonate.read
4099 " 🔵 email-templates.read/manage Grant emails.read/emails.manage — Settings Email Template Users Can Read All Emails
4100 " 🔵 Frontend Matrix State: communication.templates Row Absent — Orphan Successfully Removed
4115 4:30p 🟣 Permission Matrix CI Assertion Script Added
4116 " 🔴 Recruiter Notes Routes Fixed: `recruiters.update` → `recruiters.manage`
4117 " 🟣 Job Templates Routes Now Honor `job-templates.*` Matrix Row
4118 " 🔴 External Job HR-Contact Mutation Routes Now Require `requireManage: true`
4119 " 🔵 RBAC Permission System Architecture in uat.dharwin.backend
### Jun 3, 2026
4263 1:09p 🚨 Security Audit: 5 Critical/High Vulnerabilities Identified in Node/Express/MongoDB Backend
### Jun 5, 2026
4446 2:47p ⚖️ Architecture Design Review: Category–Position Mapping for Training LMS
4447 2:48p 🔵 Training LMS Backend: Full Code Audit of Category–Student–Position Data Layer
### Jun 8, 2026
4590 10:39a 🔵 RBAC Granular-CRUD Migration Half-Finished — 6 Active Backend Bugs Identified
4610 11:06a 🔴 Night-Shift Punch-Out: Policy Checks Now Keyed Off Session Day, Not Wall-Clock Day
4611 " 🔐 Security Review: 4-Day Stale Session Window and Unvalidated studentId in MongoDB Query
4612 " 🔄 Test Mock for Attendance.findOne Now Routes by Query Shape

Access 2511k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>