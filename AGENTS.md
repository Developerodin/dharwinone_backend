<claude-mem-context>
# Memory Context

# [uat.dharwin.backend] recent context, 2026-05-26 5:52pm GMT+5:30

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 48 obs (21,482t read) | 913,872t work | 98% savings

### May 20, 2026
2227 4:39p 🔵 uat.dharwin.backend Git Repository State Before Merge/Cleanup
2228 4:41p 🔵 Full Inventory of Scripts and Test Files Targeted for Deletion
2229 4:42p 🔵 Husky Pre-commit Hook Blocks Commit Due to ESLint Errors
2230 " 🔵 ESLint Errors Identified: Parse Error in featureFlag.service.js and Bad Import Path
2231 4:43p 🔵 Root Cause of ESLint Parse Error: Numeric Separator (60_000) Not Supported by ESLint Config
2232 " 🔴 Fixed ESLint Parse Error in featureFlag.service.js by Removing Numeric Separator
2233 " 🔴 Fixed Wrong Import Path in task.service.p2.test.js
2234 " 🟣 Feature Branch Commit Landed on feat/teams-excel-import-export
2235 " 🔵 feat/ai-meeting-summary Already Merged into main; Husky Post-checkout Hook Fails
2236 4:44p ✅ feat/teams-excel-import-export Successfully Merged into main
2237 " ✅ main Branch Clean After Merge — Full Commit History Confirmed
S579 Remove all scripts and tests from uat.dharwin.backend, merge all feature branches into main, delete merged branches, leave unmapped members as-is (May 20, 4:44 PM)
S578 Remove all scripts and tests from uat.dharwin.backend codebase, merge all feature branches into main (leave unmapped members as-is) (May 20, 4:44 PM)
2238 4:45p ✅ Feature Branches Deleted — Only main Remains
S580 Remove all scripts and tests, merge all branches into main — executed across both uat.dharwin.backend and uat.dharwin.frontend (May 20, 4:46 PM)
2239 4:46p 🔵 uat.dharwin.frontend Repository State — Same Cleanup Task Needed
2240 4:48p 🟣 Frontend Feature Branch Committed — PM UI, Teams Excel Import, Kanban Refactor
2241 " ✅ Frontend feat/teams-excel-import-export Merged into main and Branch Deleted
S581 Fix Vercel production build failure on dharwinfrontend caused by impure CSS Modules selectors in the kanban board feature (May 20, 4:49 PM)
2242 4:55p 🔵 Vercel Production Build Failure on dharwinfrontend main branch
2243 " 🔵 Build Failure Root Cause: Impure CSS Selector in kanban-board.module.css
2244 4:56p 🔵 kanban-board.module.css Contains Multiple Impure Bare :global() Selectors Beyond Line 735
2245 " 🔵 kanban-board.module.css Is a Shared Single CSS Module Across 21 Components
2246 4:57p 🔴 Fixed CSS Modules Purity Violations in kanban-board.module.css — All react-select Overrides Now Scoped Under .kbRoot
2247 4:58p 🔴 dharwinfrontend Production Build Passes After CSS Modules Fix
2248 " ✅ CSS Modules Fix Committed to main — commit 9ed27e17
2249 4:59p ✅ Fix Pushed to GitHub — Vercel Production Deploy Triggered
S582 Fix and deploy resolution for Vercel production build failure on dharwinfrontend — CSS Modules purity violation in kanban board styles (May 20, 4:59 PM)
### May 26, 2026
2982 4:45p 🔵 RBAC Permission System Has ~17 Cosmetic UI Checkboxes
2983 " 🟣 RBAC Phase 0: Granular CRUD Permission Derivation Shipped
2984 " ⚖️ RBAC Migration Strategy: Per-Phase Route Guard Swap with Legacy Aliases
2995 5:00p ⚖️ RBAC Migration Strategy: Atomic-Per-Resource (Option A) Adopted
2996 " 🚨 Cross-Resource Legacy Alias Back-Door: candidates.manage Grants offers.create
2997 " 🔵 Atomic-Per-Resource Fails If Cross-Feature Routes Gate on xxx.manage Outside Resource Route Files
3000 5:02p 🔵 Cross-File requirePermissions Audit: candidates.manage Spreads Across 6+ Route/Service Files
3001 " 🔵 jobs.manage Route Gates Co-Located BUT roleHelpers.js Has Cross-File Inline Check
3002 " 🔵 interviews.manage Route Gates Co-Located in meeting.route.js With One Cross-File Service Hit
3003 " 🔵 Full Permission Derivation Logic Confirmed: hasManage = hasCreate || hasEdit || hasDelete
3004 " 🔵 permissions.js Alias Map Reveals candidates.manage Grants 10+ Unrelated Resources
3010 5:07p 🔵 DB Audit: 16 Intentional Partial-Grant Entries Across 4 Active Roles
3011 " 🔵 candidates.manage Has 12 Cross-File Route Gates Across 4 Files Outside employee.route.js
3012 " ⚖️ Phase 0.5 Rev 2 Plan: 8 Deliverables Replacing Derivation Tightening
3013 " ⚖️ Cross-Resource Alias Back-Compat: candidates.manage Intentionally Retained in offers/pre-boarding/onboarding Aliases
3014 5:09p 🔵 src/utils/permissionCheck.js Already Exists With Alias-Aware Helpers — Phase 0.5 §2.8 Partially Pre-Done
3015 " 🔵 getUserIdsWithApiPermission Has Zero Call Sites in src/ — Notification Fan-Out Risk Is Theoretical
3016 " 🔵 Full candidates.manage Grep: Broader Scope Than Plan Documented — Attendance Middlewares + More
3017 " 🔵 Confirmed: deriveApiPermissions Always Emits .manage Alongside Granular Keys for Any Write Action
3029 5:29p ⚖️ Phase 1.5 RBAC Plan: Candidate/Employee Permission Isolation
3030 " 🔵 Three-Way Entity/Permission Conflation in RBAC System
3032 5:31p 🔵 Employee Model Confirmed: Single MongoDB `candidates` Collection for All Records
3033 " 🔵 Role Taxonomy Confirmed: "Candidate" Is Legacy Name for Employee User-Role, Not a Separate Concept
3034 " 🔵 Controller-Level `candidates.manage` Inline Checks Bypass Alias System — Phase 1.5 Must Patch Controller Too
3035 " 🔵 Permissions.js Audit: `candidates.manage` Is a Load-Bearing Fallback for 12+ Unrelated Features

Access 914k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>