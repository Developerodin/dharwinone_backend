# Phase 1 — Candidate Call: Capture & Visibility (Structured Extraction)

**Date:** 2026-06-16
**Status:** Design approved, pending spec review
**Scope:** Backend (`uat.dharwin.backend`) + calling view (`uat.dharwin.frontend`)

---

## 1. Goal

Turn each candidate verification call from a transcript + generic summary into
**structured, typed answers** that are stored on the call record, surfaced in the
calling view, and used to flag low-quality calls.

Today the call produces only a transcript, Bolna's default "Call Summary", and a
status of `completed` — even when the call actually failed (the StreamReader /
wrong-candidate class of bug looked "completed"). Phase 1 fixes both: it harvests
the answers the call exists to collect, and it stops broken calls from hiding.

**Phase 1 is intentionally additive and low-risk** — it does not change the call
flow, the agent script, or the prompt-PATCH architecture (those are Phases 2 & 3).

---

## 2. Background / verified facts

- **Bolna runs a post-call extraction pass.** Defined fields land in the execution
  payload under `extracted_data`. (Verified: Bolna "Extract Structured Data" docs.)
- **Output shape is nested `Category → Name → { objective, subjective, confidence, confidence_label }`.**
  `objective` is the typed/constrained value we store; `subjective` is free-text
  rationale; `confidence` is 0–1. (Verified against the live `General → Call Summary`
  block in real call logs.)
- **Each field has an "Expected Format"** — Text / Boolean / Numeric / Timestamp /
  Email / Custom Regex — which Bolna validates.
- **Extraction is configured in the Bolna dashboard** (Analytics → Extractions) and
  referenced by the agent like `dispositions`. It is **NOT** writable inline via the
  agent update API — attempts return `200` but are silently dropped (same behavior as
  `synthesizer.caching`). So config = one-time dashboard setup. (Verified empirically.)
- **Ingest is already wired.** The candidate agent's `webhook_url` (ngrok in dev) →
  `receiveCandidateWebhook` → `callSync.applyEvent` → the normalizer already persists
  `extracted_data`:
  [`callRecord.service.js:129`](../../../src/services/callRecord.service.js) —
  `extractedData: payload.extracted_data ?? data.extracted_data`. It lands on
  `CallRecord.extractedData` (Mixed). So no webhook or ingest changes are needed.
- **Extraction is async (post-call).** `extracted_data` may not be in the first
  webhook event; it can arrive in a later event or only via `GET /executions/{id}`.
  `callSync` already enriches across events, and `bolnaService.getExecutionFull()`
  is a reconcile fallback.

---

## 3. The 7 extraction fields (one-time dashboard setup)

Create one category **"Candidate Verification"** with these named extractions.
Prompts may reference `{candidate_name}`, `{job_title}` from `recipient_data`.

| # | Name | Format | Extraction prompt |
|---|------|--------|-------------------|
| 1 | Name Confirmed | Boolean | Did the candidate confirm their name is {candidate_name}? Return true if they agreed it is correct, false if they said it was wrong or gave a different name. |
| 2 | Corrected Name | Text | If the candidate said the name on file was wrong and gave a different name, return that corrected full name. Otherwise return empty. |
| 3 | Job Confirmed | Boolean | Did the candidate confirm the position they applied for is {job_title}? Return true if confirmed, false if they disagreed. |
| 4 | Availability | Text | When did the candidate say they could join or start if selected? Return their stated availability (e.g. "immediately", "in two weeks"). Empty if not stated. |
| 5 | Current Location | Text | What current city or location did the candidate state? Return it. Empty if not provided. |
| 6 | Still Interested | Text | Is the candidate still interested in this role? Return exactly one of: interested, not_interested, withdrew. Use "withdrew" only if they explicitly asked to withdraw their application. |
| 7 | Call Outcome | Text | Overall outcome of the verification call. Return exactly one of: fully_confirmed, partially_confirmed, refused, voicemail, no_data. |

> A short setup guide (screenshots/steps) will accompany implementation so the
> recruiter/admin can paste these in once.

---

## 4. Backend design

### 4.1 Parser — `parseCandidateExtraction(extractedData)`
New pure util (e.g. `src/utils/candidateExtraction.js`). Input: raw
`CallRecord.extractedData`. Output: a typed object, defensively handling missing
category / names / nulls.

```js
{
  nameConfirmed:   Boolean | null,
  correctedName:   String  | null,
  jobConfirmed:    Boolean | null,
  availability:    String  | null,
  currentLocation: String  | null,
  stillInterested: 'interested' | 'not_interested' | 'withdrew' | null,
  callOutcome:     'fully_confirmed' | 'partially_confirmed' | 'refused' | 'voicemail' | 'no_data' | null,
  minConfidence:   Number  | null,   // lowest confidence across present fields
  fieldsPresent:   Number,           // count of non-null answers
}
```

Reads `extractedData["Candidate Verification"][<Name>].objective` and `.confidence`.
Normalizes booleans ("true"/"false"/true) and lowercases/validates the enum fields
(unknown enum value → null, not a crash). Pure and unit-testable in isolation.

### 4.2 `CallRecord` schema additions
- `verification`: a typed sub-document holding the parsed fields above plus
  `extractedAt: Date`.
- `callQuality`: `{ status: 'ok' | 'needs_review', reasons: [String], evaluatedAt: Date }`.

Both are populated in `callSync.applyEvent` whenever `extractedData` (or transcript)
is set — i.e., derived alongside the existing enrichment, so no new pipeline.

### 4.3 Quality flag — `evaluateCallQuality(record)`
New pure util. `status = 'needs_review'` when the call is terminal/`completed` AND
any of:
- transcript contains runtime-error markers (`/an error occurred/i`,
  `/StreamReader/i`, `/unexpected keyword argument/i`), **or**
- zero real user turns in the transcript (only `assistant:` lines), **or**
- `verification.fieldsPresent === 0` (extraction empty on a completed call), **or**
- `verification.minConfidence < 0.4` (configurable threshold).
Each trigger appends a human-readable reason. Otherwise `status = 'ok'`.

### 4.4 One auto-action on `JobApplication`
When `verification.stillInterested === 'withdrew'`, set
`JobApplication.verificationCallStatus` to a withdraw state and flag for recruiter
review. **No other write-backs in Phase 1** (everything else is display-only).

### 4.5 API surface
- `getCallRecords` response includes the new `verification` and `callQuality` on
  each record (already returns the record shape — just exposes the new fields).
- Recording playback endpoints (agent-only + dual-channel) already built in this
  branch (`/call-records/:executionId/recordings[/bolna|/plivo]`).

### 4.6 Backfill
A small admin action (extend existing `call-records/sync`) re-parses
`extractedData` → `verification` + recomputes `callQuality` for historical records,
so existing calls get the new fields without re-dialing.

---

## 5. Frontend design (calling view, `uat.dharwin.frontend`)

On each call row / detail in the calling view:
- **Verification summary panel** — the 7 fields as labeled rows/chips:
  ✓/✗ Name confirmed, ✓/✗ Job confirmed, Availability, Location, Interest
  (interested / not interested / **withdrew** highlighted), Outcome.
  Null fields render as "—" / "not captured".
- **Quality badge** — amber **"Needs review"** with reason tooltip when
  `callQuality.status === 'needs_review'`; subtle/none when `ok`.
- **Recordings** — two players already specced: *Agent only (Bolna)* and
  *Full call — both voices (Plivo)*, loaded via authenticated `fetch → blob`.

The frontend only renders fields the backend now returns; no Bolna calls from the
client.

---

## 6. Data flow (end to end)

```
Call ends ─▶ Bolna post-call extraction pass
          ─▶ webhook (ngrok dev / public URL prod) ─▶ receiveCandidateWebhook
          ─▶ callSync.applyEvent
                 ├─ stores extracted_data (existing)
                 ├─ parseCandidateExtraction()  → CallRecord.verification   (new)
                 └─ evaluateCallQuality()        → CallRecord.callQuality    (new)
          ─▶ (if withdrew) JobApplication.verificationCallStatus update      (new)
Reconcile fallback: getExecutionFull() if extracted_data arrives late.
getCallRecords ─▶ calling view renders verification + quality + recordings.
```

---

## 7. Out of scope (YAGNI / later phases)

- Conversation script / agent prompt changes (Phase 2).
- Removing the per-call prompt-PATCH architecture; retries on no-answer/busy (Phase 3).
- Write-backs to candidate/application beyond the single `withdrew` action.
- `application_date_confirmed`, `wants_other_opportunities` fields (dropped).

---

## 8. Open items / spikes

1. **Code-manage extraction templates** — find the Bolna entity-create endpoint
   (the analog of how `dispositions` are created) so a recreated/cloned agent can
   re-acquire its extractions. Low priority (we are not recreating agents). Until
   then, dashboard config is a documented manual step.
2. **Production webhook URL** — before prod, set the agent `webhook_url` to
   `BACKEND_PUBLIC_URL` (`apis.dharwinone.com/...`); ngrok free domains are ephemeral.
3. **Parser validation against reality** — after the dashboard fields are created,
   run one real call and assert `parseCandidateExtraction` matches the actual
   `extracted_data` shape (case of category/name, boolean encoding) before trusting it.

---

## 9. Success criteria

- A completed verification call produces a `CallRecord.verification` with the
  candidate's confirmed/corrected answers populated from `extracted_data`.
- A broken call (runtime error / no user audio / empty extraction) is flagged
  `callQuality = needs_review`, not silently `completed`.
- The calling view shows the 7 fields, the quality badge, and both recordings.
- A `withdrew` answer updates the JobApplication status.
- Backfill repopulates the fields for historical records.
