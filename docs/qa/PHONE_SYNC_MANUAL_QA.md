# Manual QA — User / Candidate phone sync

**Scope:** After backend `syncPhoneFromUserToCandidate` and related wiring, `phoneNumber` and `countryCode` stay aligned on `User` and linked `Candidate` for all write paths.

## Preconditions

- Test user with **Candidate** profile (linked `owner`).
- Admin user with permission to edit users and candidates.
- Optional: one staff-only user (no Candidate) — only `User` is updated; no candidate row.

## Cases

| # | Action | Expected |
|---|--------|----------|
| 1 | Self: **Settings → Personal Information** (candidate path) — change phone + country, save | `GET /auth/me/with-candidate` returns same `user.phoneNumber` / `user.countryCode` as `candidate.*`. |
| 2 | **My Profile** shows same digits + dial as Personal Information (no hard refresh). | |
| 3 | **ATS → candidate edit** (same user) — change phone/country, save | User document in DB matches candidate for phone fields. |
| 4 | **Admin → Users → edit user** — set phone/country for a user who has a Candidate | Candidate document updates to match. |
| 5 | **Country-only** change (same national digits, different `countryCode`) from any surface | Both User and Candidate show new `countryCode`. |
| 6 | Staff-only user: PATCH `/auth/me` with phone | No candidate; only User updates. |
| 7 | Optional: two tabs — save phone in tab A; reload or focus tab B | Values consistent after refresh (or document if cache is eventual). |

## Smoke (API)

- `PATCH /v1/users/:userId` with `phoneNumber` / `countryCode` → linked candidate in Mongo matches.
- `PATCH /v1/auth/me/with-candidate` → `user.countryCode` equals `candidate.countryCode` after save.

## Rollback / data repair

- Optional one-off: from the backend app root, `DRY_RUN=1 node scripts/backfill-user-candidate-phone.js` then run without `DRY_RUN` when ready.
