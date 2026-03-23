# Email Notifications – When and How We Send Each One

All emails are sent via **nodemailer** using the SMTP config in `config.email` (see `.env`). The implementation lives in `src/services/email.service.js`.

---

## 1. Reset password

| When | How |
|------|-----|
| User requests a password reset | **Trigger:** `POST /v1/auth/forgot-password` with `{ email }`. **Flow:** `auth.controller.forgotPassword` → `token.service.generateResetPasswordToken(email)` → `email.service.sendResetPasswordEmail(email, token)`. |
| **Content** | Subject: "Reset Your Password - Dharwin Business Solutions". Body: link to frontend `/reset-password?token=...` (from `config.frontendBaseUrl`). HTML + plain text. |

---

## 2. Email verification

| When | How |
|------|-----|
| **A)** User registers as candidate (with invite) | **Trigger:** `POST /v1/auth/register` with `role: 'user'` and `adminId`. **Flow:** `auth.controller.register` → creates User (pending) + Candidate → `generateVerifyEmailToken` → `sendVerificationEmail(user.email, token)`. |
| **B)** Logged-in user requests verification email | **Trigger:** `POST /v1/auth/send-verification-email` (auth required). **Flow:** `auth.controller.sendVerificationEmail` → `generateVerifyEmailToken(req.user)` → `sendVerificationEmail(req.user.email, token)`. |
| **C)** Recruiter resends verification for a candidate | **Trigger:** `POST /v1/candidates/:candidateId/resend-verification-email` (candidates.manage). **Flow:** `candidate.controller.resendVerificationEmail` → `candidate.service.resendCandidateVerificationEmail` → resolve **owner User** (fallback: user by `candidate.email`) → `generateVerifyEmailToken(user)` → `sendVerificationEmail(user.email, token, { req })`. Response includes `sentToEmail` (actual inbox). |
| **Content** | Subject: "Email Verification". Body: link to frontend `/authentication/verify-email/?token=...` (from `getFrontendBaseUrl`). HTML + plain text. |

---

## 3. Candidate onboarding / preboarding invitation

| When | How |
|------|-----|
| Recruiter/admin invites candidate(s) to complete onboarding | **Trigger:** `POST /v1/auth/send-candidate-invitation` (auth required). Body: `{ email, onboardUrl }` or `{ invitations: [{ email, onboardUrl }, ...] }`. **Flow:** `auth.controller.sendCandidateInvitation` → `sendCandidateInvitationEmail(email, onboardUrl)` (per recipient). |
| **Content** | Subject: "You're Invited to Complete Your Onboarding - Dharwin". Body: link to complete onboarding (24h expiry). HTML + plain text. |

---

## 4. Candidate profile share

| When | How |
|------|-----|
| Recruiter shares a candidate profile with an external email | **Trigger:** `POST /v1/candidates/share/:candidateId` with `{ email, withDoc? }`. **Flow:** `candidate.controller.shareProfile` → `shareCandidateProfile` (generates public URL + token) → `sendCandidateProfileShareEmail(email, candidateData, { publicUrl, withDoc, sharedBy })`. |
| **Content** | Subject: "Candidate Profile: {candidateName}". Body: public profile link, whether documents are included, who shared it. HTML + plain text. |

---

## 5. Candidate account activated (pending → active)

| When | How |
|------|-----|
| Admin sets a user’s status from `pending` to `active` | **Trigger:** User update (e.g. PATCH user) that changes `status` to `active` from `pending`. **Flow:** `user.service.updateUserById` detects the transition → `sendCandidateAccountActivationEmail(user.email, user.name)` (fire-and-forget, errors logged). |
| **Content** | Subject: "Your Account Has Been Activated - Dharwin Business Solutions". Body: sign-in link (`/authentication/sign-in/`). HTML + plain text. |

---

## 6. Meeting invitation

| When | How |
|------|-----|
| **A)** A new meeting is created | **Trigger:** Meeting creation (e.g. via meetings API). **Flow:** `meeting.service.createMeeting` → after saving, collects emails from `hosts`, `emailInvites`, `candidate.email`, `recruiter.email` → for each: `sendMeetingInvitationEmail(to, { title, scheduledAt, durationMinutes, publicMeetingUrl })` (fire-and-forget). |
| **B)** Invitations are resent for an existing meeting | **Trigger:** Resend meeting invitations (e.g. `resendMeetingInvitations(meetingId)`). **Flow:** `meeting.service.resendMeetingInvitations` → same payload → `sendMeetingInvitationEmail` for each collected email. |
| **Content** | Subject: "Meeting Invitation: {title}". Body: title, scheduled time, duration, public join link. HTML + plain text. |

---

## 7. Job share

| When | How |
|------|-----|
| User shares a job posting by email | **Trigger:** `POST /v1/jobs/:jobId/share-email` with `{ to, message? }`. **Flow:** `job.controller.shareJobEmail` → loads job → `sendJobShareEmail(to, job, message)`. |
| **Content** | Subject: "Job Opportunity: {title} at {organisation}". Body: job title, org, location, description snippet, link to `/ats/jobs`. HTML + plain text. Optional custom message. |

---

## 8. Ad-hoc / export emails (generic `sendEmail`)

| When | How |
|------|-----|
| **A)** Single candidate profile sent to an email | **Trigger:** `POST /v1/candidates/:candidateId/export` with body `{ email }`. **Flow:** `candidate.controller.exportProfile` → builds plain-text summary of candidate (name, email, phone, bio, qualifications, etc.) → `sendEmail(email, "Candidate Profile: {name}", text)`. No HTML. |
| **B)** Bulk export of all candidates (CSV) to an email | **Trigger:** `POST /v1/candidates/export` with body `{ email }` (and optional query filters). **Flow:** `candidate.controller.exportAll` → `exportAllCandidates` → CSV string → `sendEmail(email, "All Candidates Export - N candidates", csvContent)`. No HTML. |

---

## Summary table

| Email type | API / trigger | Recipient | Template |
|------------|----------------|-----------|----------|
| Reset password | `POST /v1/auth/forgot-password` | Requesting user | `sendResetPasswordEmail` |
| Email verification | Register (candidate invite), send-verification-email, resend for candidate | User / candidate | `sendVerificationEmail` |
| Onboarding invitation | `POST /v1/auth/send-candidate-invitation` | Invited candidate(s) | `sendCandidateInvitationEmail` |
| Profile share | `POST /v1/candidates/share/:candidateId` | Shared-to email | `sendCandidateProfileShareEmail` |
| Account activated | User status pending → active | That user | `sendCandidateAccountActivationEmail` |
| Meeting invitation | Meeting create / resend invitations | Hosts, emailInvites, candidate, recruiter | `sendMeetingInvitationEmail` |
| Job share | `POST /v1/jobs/:jobId/share-email` | Body `to` | `sendJobShareEmail` |
| Candidate profile (single) | `POST /v1/candidates/:candidateId/export` with `email` | Body `email` | `sendEmail` (plain text) |
| All candidates CSV | `POST /v1/candidates/export` with `email` | Body `email` | `sendEmail` (CSV) |

---

## Configuration

- **SMTP:** `config.email.smtp` (from env, e.g. `EMAIL_*`).
- **From:** `config.email.from` (displayed as "Dharwin Business Solutions &lt;...&gt;" when applicable).
- **Reply-To:** `config.email.replyTo` or fallback to admin support address.
- **Frontend base URL** (for links in emails): `config.frontendBaseUrl` (e.g. reset, verify, sign-in, onboarding, meeting join).

All sending goes through `email.service.sendEmail(to, subject, text, html)`; templates that support it include both `text` and `html` for compatibility.

---

## See also

- **[NOTIFICATION_TRIGGERS.md](./NOTIFICATION_TRIGGERS.md)** — in-app notification entry points, `type` → email preference mapping, and idempotency (e.g. Bolna post-call).
