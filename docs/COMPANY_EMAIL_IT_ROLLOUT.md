# Company work email — IT rollout (Gmail / Microsoft 365)

This note is for tenant administrators enabling **in-app email** (Gmail API / Microsoft Graph) alongside **company-assigned work email** metadata in Dharwin.

## Concepts

- **Login email** (`User.email` / candidate profile email): used for authentication and invitations.
- **Company work email** (`Candidate.companyAssignedEmail`): HR record of the employer-provided mailbox; optional; does not grant access by itself.
- **Connected mailbox** (`EmailAccount`): created when the user completes **OAuth** in the product. Mail stays in Google/Microsoft; Dharwin does not store message bodies.

## Hard lock (company work email)

When the candidate has a **non-empty normalized** `companyAssignedEmail`, Communication **hard-locks** in-app mail to that address only (OAuth must match it; extra mailboxes are revoked after a successful match). **No separate “Assignment hub” toggle is required** for enforcement — the hub switch in Settings only controls whether the assignment roster UI is shown.

**OAuth policy fingerprint** still uses a stable recruiting-related id: `Candidate.adminId` when it is not the candidate’s own `owner` id; otherwise **`assignedAgent`** if set; otherwise the **candidate owner** (for `POLICY_CHANGED` detection when admins reassign).

- **GET `/v1/email/connection-policy`** returns `hardLockActive`, `expectedEmail`, and `allowedProviders` (derived from `companyEmailProvider`, or both Gmail and Outlook when unknown).
- **OAuth start** may include `login_hint` (Google) / `login_hint` + `prompt=login` (Microsoft) to steer sign-in. Wrong provider before redirect returns **400** with `WRONG_PROVIDER`.
- **OAuth callback**: if the signed-in address does not match the assignment, Dharwin **does not** keep a new wrong row; it revokes the **just-issued** app tokens where the provider API allows, logs `[mailbox_lock] mismatch_rejected`, and returns `MAILBOX_MISMATCH` or `POLICY_CHANGED` (if the assignment changed mid-flight — OAuth `state` carries a **policy fingerprint** of expected email + admin id).
- **On success** (normalized email match): the matched account is upserted as active and **all other** `EmailAccount` rows for that user are set to `revoked` with secrets cleared **in the same request** (`[mailbox_lock] bulk_revoke_succeeded` / `bulk_revoke_failed`).
- **Disconnect** while locked: **403** with `MAILBOX_LOCKED` — no token mutation. The UI hides disconnect for the linked mailbox while the lock is active.
- **Unlock**: lock clears when the admin **clears** the candidate’s company work email (empty / removed). The candidate session should refetch policy (e.g. on window focus) so connect/disconnect controls return.
- **Reassignment**: if the admin changes `companyAssignedEmail` while an old mailbox is still connected, the next policy fetch / OAuth flow applies the new expectation; mismatch handling follows the callback rules above.
- **Concurrent tabs / double OAuth**: treat as independent attempts; fingerprint and email checks apply per callback completion order.
- **IMAP / non-OAuth paths**: any future `EmailAccount` create for `provider: 'imap'` must call `assertEmailAccountPersistAllowed` first; under hard lock, only the normalized **assigned** address may be persisted.

### What Dharwin does *not* do

Dharwin **revokes only its own stored OAuth grants** (refresh/access tokens on `EmailAccount`). It does **not** sign the user out of Google or Microsoft globally or revoke org-wide IdP sessions.

## Microsoft Entra ID (Outlook / Graph)

1. **App registration**: ensure redirect URIs match the values in backend config (`config.microsoft.redirectUri`) and the environment used (UAT vs production).
2. **Delegated permissions**: Graph scopes used by the app typically include mail read/write and `offline_access` for refresh tokens. See [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).
3. **User vs admin consent**: Entra **user consent settings** can block standard users from consenting to third-party apps. If users see consent errors, an administrator may need to grant **admin consent** for the organization or adjust consent policies. See [Microsoft Q&A: standard users and Graph mail](https://learn.microsoft.com/en-us/answers/questions/5806286/standard-users-cannot-access-microsoft-graph-mail).
4. **Validation**: After OAuth, if a company work email is assigned and the connected mailbox address differs, the backend logs a **non-blocking** warning (no addresses in logs) so support can investigate without failing the connection.

## Google (Gmail API)

1. **OAuth client**: Web application type; authorized redirect URIs must match backend Google redirect URI.
2. **User consent**: Workspace users complete OAuth like any third-party app; refresh tokens are stored on `EmailAccount` for sync. See [Google Workspace auth overview](https://developers.google.com/workspace/guides/auth-overview).
3. **Verification**: If the OAuth client is published broadly, Google may require app verification; internal-only or test users reduce friction.

## Dharwin settings

- **Toggle** `companyEmailAssignmentEnabled` lives on the **logged-in recruiting user** document (`User.adminCandidateSettings`). Users with `candidates.manage` can enable it and use **Settings → Company work email**.
- **Assignment** can also be edited on the candidate form / ATS; all paths share the same validation.

## Support checklist

- [ ] Test OAuth as a **non-admin** mailbox user in the customer tenant.
- [ ] Confirm redirect URI and client IDs match the deployed environment.
- [ ] If using conditional access, ensure the app is not blocked for the target users.
- [ ] With hard lock on, confirm **403** disconnect and that **only** the assigned mailbox appears in Communication after successful OAuth.
- [ ] Confirm IT stakeholders understand: token revocation is **in-app only**, not a global Workspace/Entra sign-out.
