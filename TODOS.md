# EntityQuery remediation follow-ups

From `docs/superpowers/plans/2026-08-10-entityquery-remediation.md`.

- [ ] 2026-08-10-user-role-query.md must ship its own record allowlist before its
      executor returns User/profile records — the employees pipeline shipped without
      one and leaked a 62-key doc with presigned URLs.
      (from 2026-08-10-entityquery-remediation T14)

- [x] renderers/employees.js partitions table rows with a per-record `new Date()`
      while the section headers use the DB breakdown from resignationCutoff().
      DONE 2026-08-11: deriveEmploymentState now calls resignationCutoff().
      (from 2026-08-10-entityquery-remediation T17)

- [ ] uat.dharwin.backend-p0-security has no src/schemas or entityQuery/, and its isActive
      branch is inline in queryCandidates (~:677-686). T16/T17 land at a different site
      there. Decide whether to port.
      (from 2026-08-10-entityquery-remediation T17)

- [ ] Chat read paths should not call the profile-CREATING reconciler
      (ensureProfilesForActiveAtsRoleUsers). fetchAllRecords re-runs it per page, so
      "list all employees" can trigger up to 5 full-roster scans plus 5 write passes.
      An all-status count adds two more: computeEmploymentBreakdown calls
      buildEmployeeListMongoFilter for 'current' and for 'resigned' on top of the
      main call, so one "how many employees" is three reconciler passes.
      Route chat through employeeOwnerQuery; leave the reconciler on the write path.
      (from 2026-08-10-entityquery-remediation T18)

- [ ] A test child still holds an open handle after its tests finish, so `npm test`
      only exits because run-tests.mjs passes --test-force-exit. Making the SMTP
      transport lazy was necessary but not sufficient. Bisect scripts/test-manifest.json,
      running each half under a timeout, until one half stops exiting on its own.
      (from 2026-08-10-entityquery-remediation T3, review 2026-08-11)

- [ ] BIGGEST ONE. .gitignore:29-31 (`**/__tests__/`, `*.test.js`, `*.test.mjs`) means
      236 test files exist under src/ and only 14 are tracked. Every test the
      entityQuery remediation wrote is local-only, including the T5 regression suite
      the plan requires to "survive the handover" to the user-role-query work. The CI
      gate `npm run test:entity-query` globs __tests__ directories that are not in the
      repo, so on a fresh clone it matches nothing and passes vacuously.
      .gitignore:23 `scripts/*` adds to it: 86 of 87 files untracked, including
      run-tests.mjs, test-manifest.json, assert-employee-filter-parity.mjs and
      generate-employee-filter-joi.mjs, so `npm test` cannot run in a clone and T2's
      manifest is unversionable. `docs/` is ignored too — the plan itself is not in git.
      Repo-policy decision: both rules say "never push" and scripts/ may hold
      credential-bearing ops tooling. Minimum durable un-ignore is in the plan's
      Post-Implementation Review section.
      (from 2026-08-10-entityquery-remediation T2, review 2026-08-11)

- [ ] contextResolver.FILTER_KEYS hand-duplicates the nine filter keys in
      employeeFilter.schema.json. It is load-bearing — it blocks unknown keys from a
      foreign lastContext — but a key added to the schema and not here is silently
      never propagated. No parity check covers it.
      (review 2026-08-11)
