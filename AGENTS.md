<claude-mem-context>
# Memory Context

# [uat.dharwin.backend] recent context, 2026-06-09 3:27pm GMT+5:30

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

# uat.dharwin.backend

Dharwin UAT backend. Node.js + Express + Mongoose REST API for dharwinone.com. ESM throughout (`"type": "module"` — use `import`, never `require`).

---

## ⚠️ Critical safety rules — read these first

### Database topology

Three environments, only two databases:

- **Production** (dharwinone.com) — its own separate MongoDB. Never assume local/staging behaviour (transactions, data, topology) tells you anything about prod.
- **Staging + local dev** — **share the same MongoDB.** A script run "locally" against the default connection string (`MONGODB_URL` in `.env`) is hitting the same live data staging serves. Treat local runs of any DB-writing script as staging-impacting, never sandboxed.

**Before running any script that writes, migrates or deletes data:** state which environment(s) it targets and which connection string it will actually use. If it needs to run against **production**, call it out explicitly and unmissably on its own line:

> ⚠️ PRODUCTION DB — this needs to run against prod separately

Don't bury it in a wall of output. Confirm before running it against prod.

### Destructive operations — always confirm first

- Never `git push --force` to `dharwin/main` or `dharwin/dev`.
- Never `git reset --hard` on shared branches without confirming.
- Never drop, truncate or bulk-delete MongoDB collections/documents without confirming, and never against prod without the ⚠️ callout above.
- Deleting remote branches: ask first.

### A `dharwin/main` push is a production release

Name the target environment and confirm before pushing. Full checklist below.

---

## Branch → environment

| Environment | Branch |
|---|---|
| **Production** | `dharwin/main` |
| **Staging** | `dharwin/dev` |

`dharwin` = `Developerodin/dharwinone_*` (real upstream), `origin` = fork. `origin/master` is dead — ignore it.

---

## Commands

```
npm run dev        # local server — nodemon, NODE_ENV=development, src/index.js
npm start          # plain node src/index.js
npm test           # full suite via scripts/run-tests.mjs
npm run lint       # eslint .
npm run lint:fix   # eslint . --fix
```

**Tests are an explicit manifest, not a glob.** `npm test` runs the paths listed in `scripts/test-manifest.json`; other `*.test.js` files exist on disk but are deliberately out of the suite. **Adding a test means adding its path to that manifest**, or it never runs.

```
# one file directly
node --test --experimental-test-module-mocks src/services/offer.service.test.js

# filter by name across the suite
npm test -- --test-name-pattern="offer expiry"
```

Note: most test files and `scripts/` are gitignored, so a fresh clone runs only the few tracked tests. The runner skips manifest entries missing from disk rather than failing.

Config is loaded via `src/config/config.js` (Joi-validated); env vars come from `.env` (gitignored — `.env.example` is the reference).

## Architecture

- **Entry:** `src/index.js` (Mongo connect, then listen) → `src/app.js` (Express app + middleware chain).
- **Request path:** `src/routes/v1/` → `src/controllers/` → `src/services/` → Mongoose models in `src/models/`. Joi schemas in `src/validations/`, response shaping in `src/serializers/`, shared helpers in `src/utils/`.
- **Auth:** JWT via `passport-jwt` (`src/config/passport.js`). Route guards in `src/middlewares/` — `auth.js`, `requirePermissions`, `requireAdministratorOrPermission`.
- **RBAC:** roles and permissions live in the Mongo `Role` collection and are resolved at runtime by `src/services/permission.service.js` — there is **no** static roles config file to grep. `req.user.platformSuperUser` bypasses permission checks.
- **Background work:** schedulers in `src/jobs/` plus `*.scheduler.js` files under `src/services/`; BullMQ queues in `src/queues/`.

## Deploy mechanism

- `Dockerfile` (`EXPOSE 3000`, `CMD ["node", "src/index.js"]`) and `docker-compose.yml` (app + `mongo:4.2.1-bionic`) exist for container/local runs.
- **No CI runs on push.** `.github/` is gitignored, so the workflows that exist locally (`entity-query-tests.yml`, `keep-warm.yml`) have never been pushed. Nothing tests, builds or deploys automatically — a push only moves the branch.
- `pm2` (^6.0.14) is a dependency.

<!-- TODO — not derivable from the repo, please confirm and fill in:
- how prod actually picks up a push (manual pull on the host? webhook?)
- process manager + restart command on the host (pm2 restart <name>? systemd?)
- host access (who/how, or "no direct SSH — coordinate with X")
-->

---

## Production push checklist

Run through this before every `dharwin/main` push.

**1. No env flip needed here.** Unlike the frontend, `.env` is gitignored in this repo — the server reads its own `.env`. Nothing in the push touches it.

**2. New env vars — check on every release.** Merging code never creates env vars. Any new `process.env.*` the release introduces must be set on the host **before** the deploy, or the feature silently no-ops or boot fails. Diff the release against what is live:

```
git diff dharwin/main..HEAD -- .env.example src/config/config.js
```

Set anything new on the host first, then deploy.

**3. Other things a merge does not run:**
- new dependencies → `npm install` on the host
- DB migrations / backfill scripts → run against prod separately (see "Database topology")
- new schedulers/cron → confirm they are registered and enabled on the host

**4. Verify after pushing** with `git ls-remote dharwin main`, not the local remote-tracking ref, which goes stale. A fast-forward keeps original author dates, so nothing appears dated "today" on GitHub.

**5. Sweep merged feature branches — only after a FULL merge.** A feature branch is deletable only once it has landed in **both** `dharwin/dev` (staging) **and** `dharwin/main` (production). Merged into one but not the other means it is still in flight — keep it.

Fetch first so the refs are not stale, then verify both:

```
git fetch dharwin
git merge-base --is-ancestor <branch> dharwin/dev    # exit 0 = in staging
git merge-base --is-ancestor <branch> dharwin/main   # exit 0 = in production
```

Delete **only if both returned 0**:

```
git branch -d <branch>    # lowercase -d refuses if commits would be lost
```

If either check is non-zero, stop — the branch has unshipped work. Never delete `main`, `dev`, or `master`.

---

## Behavioral guidelines

Guidelines to reduce common LLM coding mistakes. **Tradeoff:** these bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### 5. Reuse Before Building

**Search the codebase before writing anything new. Default to the laziest thing that works.**

Take the first rung that holds: stdlib → native platform feature → an already-installed dependency → **existing code in this repo** → new code. Only the last rung adds surface area.

Before adding any module, function, helper or component:
- Search for one that already does it, or nearly does it. Name what you found and why it does or doesn't fit.
- Prefer a minimal, additive change to an existing function over writing a parallel one.
- Two near-identical implementations *is* the bug. If you are about to write the second, change the first.
- If nothing fits, say what you searched for before writing the minimum.

**Reuse must not break existing callers.** Before changing shared code, list who calls it. Prefer additive changes (a new optional parameter, a new branch) over changing a signature or altering current behaviour. If the change would alter what existing callers already get, that is not reuse — stop and say so rather than quietly changing it.

The test: could a reviewer point at existing code and ask "why didn't you just use this?"

### 6. Think Long-Term, Name the Failure Modes

**Simple is not the same as short-sighted.** Rule 2 forbids speculative *code*, not thought.

Before settling on an approach:
- State how it fails. What happens on a retry, a duplicate request, two processes running at once, a partial write, empty input, a missing record, a timeout?
- Say which of those you handle and which you deliberately don't, and why.
- Name the ceiling: at what scale, load or edge case does this stop working? Leave that in a comment where the shortcut lives, with the upgrade path.
- When two options are otherwise equal, take the one that is cheapest to change later.

**This does not license speculative code.** Handle the failure modes that are real for this system today; *document* the rest instead of building for them. Thinking about the worst case is free — coding for an imaginary one is not.

The test: if this breaks at 3am, would the person paged find the failure mode already named?

---

## Agent rules

### Test run output (do not commit)

Do not commit local or CI scratch files from test runs. Redirect verbose test output to gitignored paths or delete after use.

Examples (see `.gitignore`):
- `test-full-output.log`, `test-full-final.log` (`test-full*.log`)
- `.test-full-output.txt`
- `*.test-output.log`
