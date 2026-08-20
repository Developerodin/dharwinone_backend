# Security checklist — Communication contact discovery

Design: `docs/superpowers/specs/2026-08-20-communication-contact-discovery-rbac-design.md`

**Re-run and sign off before ANY release that touches:**
`src/services/chat.service.js`, `src/controllers/chat.controller.js`,
`src/services/communicationAccess*.js`, `src/services/user.service.js`,
`src/routes/v1/chat.route.js`.

## Directory scope

- [ ] `communication.directory:all` account — `GET /v1/chats/users/search` returns other users, `totalResults` > 0.
- [ ] `communication.directory:referred` account — results contain **only** its own referred people.
- [ ] No directory permission — `GET /v1/chats/users/search` returns **403**.

## Exact-email lookup

- [ ] Full valid address → 200, one contact, no `roleName`.
- [ ] Partial address (`harsh@`) → **400** from validator.
- [ ] Unknown address → 404 `No registered user found with that email`.
- [ ] 21 lookups in one minute → 429 on the last.

## Write-path bypass

- [ ] Restricted account, direct chat with stranger id → **403**.
- [ ] Restricted account, group with stranger → **403**.
- [ ] Restricted account, group call with stranger → **403**.
- [ ] Restricted account, direct chat via email → 200.

## Regression

- [ ] `git diff --stat src/services/user.service.js` is empty.

**Signed off by:** ____________  **Date:** ____________  **Release:** ____________
