<claude-mem-context>
# Memory Context

# [uat.dharwin.backend] recent context, 2026-05-28 2:06pm GMT+5:30

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (26,887t read) | 2,008,810t work | 99% savings

### May 20, 2026
S579 Remove all scripts and tests from uat.dharwin.backend, merge all feature branches into main, delete merged branches, leave unmapped members as-is (May 20, 4:44 PM)
S578 Remove all scripts and tests from uat.dharwin.backend codebase, merge all feature branches into main (leave unmapped members as-is) (May 20, 4:44 PM)
S580 Remove all scripts and tests, merge all branches into main — executed across both uat.dharwin.backend and uat.dharwin.frontend (May 20, 4:46 PM)
S581 Fix Vercel production build failure on dharwinfrontend caused by impure CSS Modules selectors in the kanban board feature (May 20, 4:49 PM)
S582 Fix and deploy resolution for Vercel production build failure on dharwinfrontend — CSS Modules purity violation in kanban board styles (May 20, 4:59 PM)
### May 28, 2026
3385 11:52a 🔵 Permission Derivation Architecture: Raw Strings vs Derived API Strings in Alias Arrays
3386 " 🔵 Controller canUpdateJoiningDate/canUpdateResignDate Bypass Alias System Entirely
3387 " 🔵 Unintended Access: Adding employees.manage to candidates.manage Alias Grants Override Endpoint Access
3388 " 🔵 Migration Must Use bulkWrite; role.save() Loop Triggers Per-Save bustRoleRegistry
3408 12:13p 🔵 PR1 Unified Workforce Migration: 15 Test/Rollout Plan Gaps Identified
3409 12:16p 🔵 Migration A1 Is a TeamMember Structural Migration, Not a Permission Migration
3410 " 🔵 Migration Uses Raw bulkWrite — Bypasses Mongoose Hooks Including bustRoleRegistry
3411 " 🔵 Test Suite Covers Only 8 Pure-Function Unit Tests — All I/O Paths Untested
3412 " 🔵 permission.service.js Uses Rule-Based deriveApiPermissions with No Hardcoded Map
3418 12:41p ⚖️ ATS Employees Permission Row — PR1 Final Spec Design Decisions
3419 12:43p 🔵 deriveApiPermissions Uses Generic Algorithm — No Code Change Needed for ats.employees:* Derivation
3420 " 🔵 employmentStatus Field Mismatch: Spec Enum vs Actual DB Schema
3421 " 🔵 Both /candidates and /employees Routes Share the Same employee.route.js Router Instance
3422 " 🔵 Controller-Level canUpdateJoiningDate/canUpdateResignDate Are Used Post-Route-Gate for Business Logic
3423 " 🔵 roleRegistry.js bustRoleRegistry is Cache-Only — Auth Path Queries DB Directly Per Request
3439 1:33p ⚖️ ATS Employees Permission Row — Implementation Architecture
3440 " 🔵 ESM Import-Append Anti-Pattern in Multi-Task Test File
3441 " 🔵 Task 5 Controller Test Imports Names That Are Middleware Arrays, Not Exported Functions
3442 " 🔵 Windows PowerShell Incompatibilities Across Multiple Plan Tasks
3443 " 🔵 runReverse Uses Non-Standard `.stream()` API on MongoDB Cursor
3444 " 🔵 Task 15 Supertest Smoke References Non-Existent Helper Module
3445 " 🔵 Task 4 Assumes `requireAnyOfPermissions` Is Already Imported Without Verification
3450 1:37p 🔵 Project Uses Node Built-in Test Runner, NOT Jest — Plan's Test APIs Are Wrong Framework
3451 " 🔵 `mongodb-memory-server` and `supertest` Are Not Installed — Tasks 12 and 15 Will Fail at Import
3452 " 🔵 `deriveApiPermissions` Is NOT Exported from permission.service.js — Task 2 Export Step Is Required
3453 " 🔵 `requireAnyOfPermissions` IS Already Imported in employee.route.js — Task 4 Assumption Verified
3454 " 🔵 Controller Helpers Are Internal-Only — `employee.service.js` Has a Second Permission Gate via `req.user` Flag
3455 " 🔵 Task 5 Export Will Conflict With Existing Multiple Named Export Blocks in employee.controller.js
3456 " 🔵 `src/__tests__/routes/helpers/test-fixtures.js` Does Not Exist — Task 15 Is Missing Infrastructure
3457 " 🔵 Migration Script Pattern — Node --test + node:assert, No bustRoleRegistry Import Issue
3458 " 🔵 `candidates.joiningDate` Alias in permissions.js Has 4 Granting Strings Including Raw ATS Bundle
3461 1:48p ⚖️ ATS Employees Permission Row — Revised Implementation Plan (PR1)
3462 " 🟣 Migration Script: `2026-05-28-ats-employees-permission-row.js` with Full Lifecycle
3463 " ⚖️ Frontend `candidate-permissions.ts` Uses Manage-Only Actions (Not View) for Edit Affordances
3464 " ⚖️ Commit Ordering Safety: Controller Helpers Before Route Gates Before Dead Alias Deletion
3465 " ⚖️ PR1 Defers Supertest + mongodb-memory-server Integration Tests to PR2
3466 1:50p 🔵 Current Codebase State Confirmed: All Pre-Conditions for PR1 Tasks Verified
3467 " 🔵 New P1 Bug Found: `requireAnyOfPermissions` Resolves `candidates.manage` Through Alias Table — Grants May Be Wider Than Expected
3476 1:55p ⚖️ ATS Employees Permission Row — Commit-Order Safety Strategy
3477 " 🟣 Controller Helpers Rewired: employees.manage + onboarding.manage Accepted for Date Updates
3478 " 🟣 Migration Script: migrateRole Pure Transform with Verbatim Preservation
3479 " ⚖️ PR1 Test Strategy: Pure-Function node:test Only, supertest Deferred to PR2
3480 " 🟣 preFlight: Unknown Permission String Check is Informational, Not Blocking
3481 " 🟣 Frontend: canEditCandidateJoiningDate/ResignDate Rewritten for Raw String Matching
3482 " 🟣 Route Gates Flipped: PATCH joining-date and resign-date Accept New Permission Keys
3483 1:57p 🔵 permission.service.js: deriveApiPermissions NOT Exported, Rule Confirms ats.employees Auto-Derivation
3484 " 🔵 permissions.js: Dead Alias Entries Confirmed at Lines 82-95, permissionAliases Already Named-Exported
3486 1:58p 🔵 Full Baseline Audit: requireAnyOfPermissions Already Imported, bustRoleRegistry Correctly Exported, All Files Match Plan Assumptions
3487 " 🔵 requireAnyOfPermissions Goes Through Alias Expansion — employees.manage Has No Alias Entry, Checks Derived Key Directly
3488 " 🔵 bustRoleRegistry Is Synchronous — Migration await Call Is Harmless No-Op

Access 2009k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>