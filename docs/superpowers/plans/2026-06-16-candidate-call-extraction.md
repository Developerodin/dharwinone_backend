# Candidate Call Structured Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each candidate verification call into typed, structured answers + a call-quality flag, stored on `CallRecord`, surfaced in the calling view, and acted on for withdrawals.

**Architecture:** Bolna's post-call extraction lands in `CallRecord.extractedData` (already ingested via the existing webhook). Two pure utils parse it into typed fields and compute a quality flag; a combiner is invoked at the two existing extractedData write-sites. The frontend renders the new fields + quality badge + both recordings.

**Tech Stack:** Node.js (ESM), Mongoose, `node:test` (built-in test runner, NOT jest), Next.js + TypeScript frontend, Axios API client.

**Spec:** `docs/superpowers/specs/2026-06-16-candidate-call-extraction-design.md`

---

## File Structure

**Backend (`uat.dharwin.backend`)**
- Create: `src/utils/candidateExtraction.js` — pure parser + quality eval + combiner
- Create: `src/utils/__tests__/candidateExtraction.test.js` — unit tests
- Modify: `src/models/callRecord.model.js` — add `verification` + `callQuality` subdocs
- Modify: `src/models/jobApplication.model.js` — add `withdrawn` to enum
- Modify: `src/services/callSync.service.js` — derive insights in `applyEvent` (webhook path)
- Modify: `src/services/callRecord.service.js` — derive insights in the reconcile/backfill path
- Modify: `src/controllers/bolna.controller.js` — withdraw auto-action; backfill re-derive
- Modify: `package.json` — register the new test file in the `test` script

**Frontend (`uat.dharwin.frontend`)**
- Modify: `shared/lib/api/bolna.ts` — extend `CallRecord` type; add recording fetch helpers
- Create: `app/(components)/(contentlayout)/communication/calling/_components/CallVerificationPanel.tsx`
- Create: `app/(components)/(contentlayout)/communication/calling/_components/CallRecordings.tsx`
- Modify: `app/(components)/(contentlayout)/communication/calling/page.tsx` — render the two components

---

## Task 1: Extraction parser util

**Files:**
- Create: `src/utils/candidateExtraction.js`
- Test: `src/utils/__tests__/candidateExtraction.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/candidateExtraction.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateExtraction } from '../candidateExtraction.js';

const sample = {
  'Candidate Verification': {
    'Name Confirmed': { objective: 'true', confidence: 0.95 },
    'Corrected Name': { objective: '', confidence: 0.9 },
    'Job Confirmed': { objective: false, confidence: 0.8 },
    'Availability': { objective: 'in two weeks', confidence: 0.7 },
    'Current Location': { objective: 'Delhi', confidence: 0.6 },
    'Still Interested': { objective: 'Interested', confidence: 0.9 },
    'Call Outcome': { objective: 'partially_confirmed', confidence: 0.5 },
  },
};

test('parses typed fields from nested extracted_data', () => {
  const r = parseCandidateExtraction(sample);
  assert.equal(r.nameConfirmed, true);
  assert.equal(r.correctedName, null); // empty string -> null
  assert.equal(r.jobConfirmed, false);
  assert.equal(r.availability, 'in two weeks');
  assert.equal(r.currentLocation, 'Delhi');
  assert.equal(r.stillInterested, 'interested'); // normalized
  assert.equal(r.callOutcome, 'partially_confirmed');
  assert.equal(r.fieldsPresent, 6); // correctedName is null
  assert.equal(r.minConfidence, 0.5);
});

test('returns all-null on missing/empty input', () => {
  const r = parseCandidateExtraction(null);
  assert.equal(r.nameConfirmed, null);
  assert.equal(r.fieldsPresent, 0);
  assert.equal(r.minConfidence, null);
});

test('drops unknown enum values to null', () => {
  const r = parseCandidateExtraction({
    'Candidate Verification': { 'Still Interested': { objective: 'maybe', confidence: 0.9 } },
  });
  assert.equal(r.stillInterested, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/utils/__tests__/candidateExtraction.test.js`
Expected: FAIL — `Cannot find module '../candidateExtraction.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/candidateExtraction.js`:

```js
/**
 * Parse Bolna's nested `extracted_data` (Category -> Name -> {objective, confidence})
 * into typed candidate-verification fields. Defensive: missing/unknown -> null.
 */

const CATEGORY = 'Candidate Verification';
const FIELD = {
  nameConfirmed: 'Name Confirmed',
  correctedName: 'Corrected Name',
  jobConfirmed: 'Job Confirmed',
  availability: 'Availability',
  currentLocation: 'Current Location',
  stillInterested: 'Still Interested',
  callOutcome: 'Call Outcome',
};
const INTEREST = new Set(['interested', 'not_interested', 'withdrew']);
const OUTCOME = new Set(['fully_confirmed', 'partially_confirmed', 'refused', 'voicemail', 'no_data']);

function readField(extractedData, name) {
  const cat = extractedData && extractedData[CATEGORY];
  const entry = cat && cat[name];
  if (!entry || typeof entry !== 'object') return { value: null, confidence: null };
  return {
    value: entry.objective ?? null,
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
  };
}
function toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
}
function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function toEnum(v, allowed) {
  const s = toText(v);
  if (!s) return null;
  const k = s.toLowerCase().replace(/\s+/g, '_');
  return allowed.has(k) ? k : null;
}

export function parseCandidateExtraction(extractedData) {
  const raw = {
    nameConfirmed: readField(extractedData, FIELD.nameConfirmed),
    correctedName: readField(extractedData, FIELD.correctedName),
    jobConfirmed: readField(extractedData, FIELD.jobConfirmed),
    availability: readField(extractedData, FIELD.availability),
    currentLocation: readField(extractedData, FIELD.currentLocation),
    stillInterested: readField(extractedData, FIELD.stillInterested),
    callOutcome: readField(extractedData, FIELD.callOutcome),
  };
  const out = {
    nameConfirmed: toBool(raw.nameConfirmed.value),
    correctedName: toText(raw.correctedName.value),
    jobConfirmed: toBool(raw.jobConfirmed.value),
    availability: toText(raw.availability.value),
    currentLocation: toText(raw.currentLocation.value),
    stillInterested: toEnum(raw.stillInterested.value, INTEREST),
    callOutcome: toEnum(raw.callOutcome.value, OUTCOME),
  };
  const confs = [];
  let present = 0;
  for (const key of Object.keys(out)) {
    if (out[key] != null) {
      present += 1;
      if (raw[key].confidence != null) confs.push(raw[key].confidence);
    }
  }
  out.minConfidence = confs.length ? Math.min(...confs) : null;
  out.fieldsPresent = present;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/utils/__tests__/candidateExtraction.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/candidateExtraction.js src/utils/__tests__/candidateExtraction.test.js
git commit -m "feat(bolna): parse candidate extraction into typed fields"
```

---

## Task 2: Call-quality evaluator

**Files:**
- Modify: `src/utils/candidateExtraction.js`
- Test: `src/utils/__tests__/candidateExtraction.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `src/utils/__tests__/candidateExtraction.test.js`:

```js
import { evaluateCallQuality } from '../candidateExtraction.js';

test('flags runtime-error transcript as needs_review', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: An error occurred: StreamReader.readline()...',
    verification: { fieldsPresent: 0, minConfidence: null },
    extractionPresent: false,
  });
  assert.equal(q.status, 'needs_review');
  assert.ok(q.reasons.includes('runtime_error_in_transcript'));
});

test('flags completed call with no user turns', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: Hi\nassistant: Bye',
    verification: { fieldsPresent: 2, minConfidence: 0.9 },
    extractionPresent: true,
  });
  assert.equal(q.status, 'needs_review');
  assert.ok(q.reasons.includes('no_user_turns'));
});

test('does NOT flag empty extraction when extraction not yet received', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: Hi\nuser: yes',
    verification: { fieldsPresent: 0, minConfidence: null },
    extractionPresent: false,
  });
  assert.equal(q.status, 'ok');
});

test('flags empty extraction when extraction present but empty', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: Hi\nuser: yes',
    verification: { fieldsPresent: 0, minConfidence: null },
    extractionPresent: true,
  });
  assert.equal(q.status, 'needs_review');
  assert.ok(q.reasons.includes('empty_extraction'));
});

test('ok for a clean completed call', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: Hi\nuser: yes that is correct',
    verification: { fieldsPresent: 5, minConfidence: 0.8 },
    extractionPresent: true,
  });
  assert.equal(q.status, 'ok');
  assert.deepEqual(q.reasons, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/utils/__tests__/candidateExtraction.test.js`
Expected: FAIL — `evaluateCallQuality is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/utils/candidateExtraction.js`:

```js
const ERROR_MARKERS = [/an error occurred/i, /streamreader/i, /unexpected keyword argument/i];
const MIN_CONFIDENCE = 0.4;

/**
 * Derive a call-quality flag. Pure (no timestamps — caller stamps evaluatedAt).
 * @param {{ status?: string, transcript?: string, verification: object, extractionPresent: boolean }} p
 * @returns {{ status: 'ok'|'needs_review', reasons: string[] }}
 */
export function evaluateCallQuality({ status, transcript, verification, extractionPresent }) {
  const reasons = [];
  const isCompleted = String(status || '').toLowerCase() === 'completed';
  const t = String(transcript || '');

  if (ERROR_MARKERS.some((re) => re.test(t))) reasons.push('runtime_error_in_transcript');

  const userTurns = (t.match(/^\s*user:/gim) || []).length;
  if (isCompleted && userTurns === 0) reasons.push('no_user_turns');

  if (isCompleted && extractionPresent && verification && verification.fieldsPresent === 0) {
    reasons.push('empty_extraction');
  }
  if (
    isCompleted &&
    extractionPresent &&
    verification &&
    verification.minConfidence != null &&
    verification.minConfidence < MIN_CONFIDENCE
  ) {
    reasons.push('low_confidence');
  }

  return { status: reasons.length ? 'needs_review' : 'ok', reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/utils/__tests__/candidateExtraction.test.js`
Expected: PASS (8 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/utils/candidateExtraction.js src/utils/__tests__/candidateExtraction.test.js
git commit -m "feat(bolna): add call-quality evaluator"
```

---

## Task 3: Combiner — `deriveCallInsights`

**Files:**
- Modify: `src/utils/candidateExtraction.js`
- Test: `src/utils/__tests__/candidateExtraction.test.js`

- [ ] **Step 1: Add the failing test**

Append to the test file:

```js
import { deriveCallInsights } from '../candidateExtraction.js';

test('deriveCallInsights returns verification + callQuality', () => {
  const r = deriveCallInsights({
    status: 'completed',
    transcript: 'assistant: Hi\nuser: yes',
    extractedData: { 'Candidate Verification': { 'Name Confirmed': { objective: true, confidence: 0.9 } } },
  });
  assert.equal(r.verification.nameConfirmed, true);
  assert.equal(r.verification.fieldsPresent, 1);
  assert.equal(r.callQuality.status, 'ok');
});

test('deriveCallInsights marks extractionPresent false when no extracted_data', () => {
  const r = deriveCallInsights({ status: 'completed', transcript: 'assistant: Hi\nuser: yes', extractedData: null });
  assert.equal(r.verification.fieldsPresent, 0);
  assert.equal(r.callQuality.status, 'ok'); // not flagged empty — extraction absent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/utils/__tests__/candidateExtraction.test.js`
Expected: FAIL — `deriveCallInsights is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/utils/candidateExtraction.js`:

```js
/**
 * Combine parse + quality. Pure. Caller stamps extractedAt/evaluatedAt.
 * @param {{ extractedData?: object, transcript?: string, status?: string }} p
 */
export function deriveCallInsights({ extractedData, transcript, status }) {
  const verification = parseCandidateExtraction(extractedData);
  const extractionPresent =
    !!extractedData && typeof extractedData === 'object' && Object.keys(extractedData).length > 0;
  const callQuality = evaluateCallQuality({ status, transcript, verification, extractionPresent });
  return { verification, callQuality };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/utils/__tests__/candidateExtraction.test.js`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/utils/candidateExtraction.js src/utils/__tests__/candidateExtraction.test.js
git commit -m "feat(bolna): add deriveCallInsights combiner"
```

---

## Task 4: CallRecord schema fields

**Files:**
- Modify: `src/models/callRecord.model.js` (after line 113 `extractedData`)

- [ ] **Step 1: Add the schema fields**

In `src/models/callRecord.model.js`, immediately after the `extractedData` line (`extractedData: mongoose.Schema.Types.Mixed,`), add:

```js
    /** Typed candidate-verification answers parsed from extractedData. */
    verification: {
      nameConfirmed: { type: Boolean, default: null },
      correctedName: { type: String, default: null },
      jobConfirmed: { type: Boolean, default: null },
      availability: { type: String, default: null },
      currentLocation: { type: String, default: null },
      stillInterested: { type: String, enum: ['interested', 'not_interested', 'withdrew', null], default: null },
      callOutcome: {
        type: String,
        enum: ['fully_confirmed', 'partially_confirmed', 'refused', 'voicemail', 'no_data', null],
        default: null,
      },
      minConfidence: { type: Number, default: null },
      fieldsPresent: { type: Number, default: 0 },
      extractedAt: { type: Date, default: null },
    },
    /** Derived call-quality flag — stops broken calls masquerading as completed. */
    callQuality: {
      status: { type: String, enum: ['ok', 'needs_review'], default: 'ok' },
      reasons: { type: [String], default: [] },
      evaluatedAt: { type: Date, default: null },
    },
```

- [ ] **Step 2: Verify the model loads**

Run: `node -e "import('./src/models/callRecord.model.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`

- [ ] **Step 3: Commit**

```bash
git add src/models/callRecord.model.js
git commit -m "feat(bolna): add verification + callQuality fields to CallRecord"
```

---

## Task 5: Hook insights into the webhook path (`callSync.applyEvent`)

**Files:**
- Modify: `src/services/callSync.service.js` (import at top; insert after line 208 `if (norm.language) set.language = norm.language;`)

- [ ] **Step 1: Add the import**

At the top of `src/services/callSync.service.js`, add alongside the existing imports:

```js
import { deriveCallInsights } from '../utils/candidateExtraction.js';
```

- [ ] **Step 2: Derive insights when extraction or transcript is present**

In `applyEvent`, immediately after the line `if (norm.language) set.language = norm.language;` (currently line 208), insert:

```js
  // Phase 1: derive typed verification answers + quality flag whenever this event
  // carries an extraction or transcript. extractedAt/evaluatedAt stamped from event ts.
  if (norm.extractedData || norm.transcript) {
    const insights = deriveCallInsights({
      extractedData: norm.extractedData,
      transcript: norm.transcript,
      status,
    });
    set.verification = { ...insights.verification, extractedAt: eventTs };
    set.callQuality = { ...insights.callQuality, evaluatedAt: eventTs };
  }
```

- [ ] **Step 3: Verify the service loads**

Run: `node -e "import('./src/services/callSync.service.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`

- [ ] **Step 4: Commit**

```bash
git add src/services/callSync.service.js
git commit -m "feat(bolna): derive verification + quality on webhook events"
```

---

## Task 6: Hook insights into the reconcile/backfill path (`callRecord.service.js`)

**Files:**
- Modify: `src/services/callRecord.service.js` (import at top; insert after line 453, where `update.extractedData = extracted;`)

- [ ] **Step 1: Add the import**

At the top of `src/services/callRecord.service.js`, add:

```js
import { deriveCallInsights } from '../utils/candidateExtraction.js';
```

- [ ] **Step 2: Derive insights in the reconcile path**

In the function that builds `update` (around line 449-453), replace the block:

```js
  const extracted =
    payload.extracted_data ?? data.extracted_data ?? details.extracted_data;
  if (extracted && typeof extracted === 'object') {
    update.extractedData = extracted;
  }
```

with:

```js
  const extracted =
    payload.extracted_data ?? data.extracted_data ?? details.extracted_data;
  if (extracted && typeof extracted === 'object') {
    update.extractedData = extracted;
  }
  // Phase 1: re-derive typed answers + quality from extraction/transcript on reconcile.
  if (extracted || norm.transcript) {
    const insights = deriveCallInsights({
      extractedData: extracted,
      transcript: norm.transcript,
      status: norm.status,
    });
    const now = new Date();
    update.verification = { ...insights.verification, extractedAt: now };
    update.callQuality = { ...insights.callQuality, evaluatedAt: now };
  }
```

- [ ] **Step 3: Verify the service loads**

Run: `node -e "import('./src/services/callRecord.service.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`

> Note: confirm `norm` is in scope at this point in the function (it is built earlier from `normalizePayload`). If the variable is named differently here, use the local normalized object; the transcript field is `<norm>.transcript`.

- [ ] **Step 4: Commit**

```bash
git add src/services/callRecord.service.js
git commit -m "feat(bolna): derive verification + quality on reconcile/backfill"
```

---

## Task 7: Withdraw auto-action on JobApplication

**Files:**
- Modify: `src/models/jobApplication.model.js:35-38` (enum)
- Modify: `src/controllers/bolna.controller.js` (in `receiveCandidateWebhook`, after `applyEvent`)

- [ ] **Step 1: Add `withdrawn` to the enum**

In `src/models/jobApplication.model.js`, change:

```js
    verificationCallStatus: { 
      type: String, 
      enum: ['pending', 'initiated', 'completed', 'failed', 'no_answer'],
    },
```

to:

```js
    verificationCallStatus: { 
      type: String, 
      enum: ['pending', 'initiated', 'completed', 'failed', 'no_answer', 'withdrawn'],
    },
```

- [ ] **Step 2: Apply the withdraw action in the candidate webhook**

In `src/controllers/bolna.controller.js`, inside `receiveCandidateWebhook`, locate the block after `const record = result.record;` where it looks up the JobApplication. After the existing `if (record?.executionId) { ... }` lookup, add a withdraw update keyed off the parsed verification:

```js
  // Phase 1: candidate explicitly asked to withdraw → reflect on the application.
  if (record?.executionId && record?.verification?.stillInterested === 'withdrew') {
    const JobApplication = (await import('../models/jobApplication.model.js')).default;
    await JobApplication.updateOne(
      { verificationCallExecutionId: record.executionId },
      { $set: { verificationCallStatus: 'withdrawn' } }
    );
    logger.info(`[Bolna] Candidate withdrew via verification call execId=${record.executionId}`);
  }
```

- [ ] **Step 3: Verify both modules load**

Run: `node -e "Promise.all([import('./src/models/jobApplication.model.js'),import('./src/controllers/bolna.controller.js')]).then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`

- [ ] **Step 4: Commit**

```bash
git add src/models/jobApplication.model.js src/controllers/bolna.controller.js
git commit -m "feat(bolna): mark application withdrawn when candidate withdraws on call"
```

---

## Task 8: Backfill historical records

**Files:**
- Modify: `src/services/callRecord.service.js` (add `backfillVerification` export)
- Modify: `src/controllers/bolna.controller.js` (call it from `syncMissingCallRecords`)

- [ ] **Step 1: Add a backfill function**

In `src/services/callRecord.service.js`, add and export:

```js
/**
 * Re-derive verification + callQuality for stored records that have extractedData
 * or a transcript but no verification yet. Idempotent.
 */
export async function backfillVerification(limit = 200) {
  const records = await CallRecord.find({
    'verification.extractedAt': null,
    $or: [{ extractedData: { $ne: null } }, { transcript: { $ne: null } }],
  })
    .limit(limit)
    .lean();

  let updated = 0;
  for (const r of records) {
    const insights = deriveCallInsights({
      extractedData: r.extractedData,
      transcript: r.transcript,
      status: r.status,
    });
    const now = new Date();
    await CallRecord.updateOne(
      { _id: r._id },
      {
        $set: {
          verification: { ...insights.verification, extractedAt: now },
          callQuality: { ...insights.callQuality, evaluatedAt: now },
        },
      }
    );
    updated += 1;
  }
  return { updated, scanned: records.length };
}
```

> Confirm `CallRecord` is imported in this file (it is used elsewhere in the service). If the default export object is the public surface, also add `backfillVerification` to it.

- [ ] **Step 2: Invoke it from the sync endpoint**

In `src/controllers/bolna.controller.js`, in `syncMissingCallRecords`, after the existing `backfill`/`sync` calls, add:

```js
  const verif = await callRecordService.backfillVerification(200);
```

and include it in the response payload:

```js
    verificationBackfilled: verif.updated,
```

- [ ] **Step 3: Verify modules load**

Run: `node -e "import('./src/controllers/bolna.controller.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`

- [ ] **Step 4: Commit**

```bash
git add src/services/callRecord.service.js src/controllers/bolna.controller.js
git commit -m "feat(bolna): backfill verification + quality for historical calls"
```

---

## Task 9: Register the new test file

**Files:**
- Modify: `package.json` (the `test` script)

- [ ] **Step 1: Add the test file to the explicit list**

In `package.json`, the `test` script is a `node --test ... <space-separated file list>`. Append the new file path to that list:

```
./src/utils/__tests__/candidateExtraction.test.js
```

- [ ] **Step 2: Run the full suite to confirm it's picked up**

Run: `npm test 2>&1 | grep -i candidateExtraction`
Expected: the candidateExtraction tests appear and pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(bolna): register candidateExtraction tests in npm test"
```

---

## Task 10: Frontend API types + recording helpers

**Files:**
- Modify: `uat.dharwin.frontend/shared/lib/api/bolna.ts`

- [ ] **Step 1: Extend the `CallRecord` type**

In `shared/lib/api/bolna.ts`, add these types and extend `CallRecord`:

```ts
export type CallVerification = {
  nameConfirmed?: boolean | null;
  correctedName?: string | null;
  jobConfirmed?: boolean | null;
  availability?: string | null;
  currentLocation?: string | null;
  stillInterested?: "interested" | "not_interested" | "withdrew" | null;
  callOutcome?:
    | "fully_confirmed"
    | "partially_confirmed"
    | "refused"
    | "voicemail"
    | "no_data"
    | null;
  minConfidence?: number | null;
  fieldsPresent?: number;
  extractedAt?: string | null;
};

export type CallQuality = {
  status?: "ok" | "needs_review";
  reasons?: string[];
  evaluatedAt?: string | null;
};
```

Add to the `CallRecord` type (after `extractedData?: unknown;`):

```ts
  verification?: CallVerification;
  callQuality?: CallQuality;
```

- [ ] **Step 2: Add recording metadata + blob fetch helpers**

Append to `shared/lib/api/bolna.ts`:

```ts
export type CallRecordingsResponse = {
  success: boolean;
  executionId: string;
  provider?: string | null;
  recordings: {
    bolna: { available: boolean; channel?: string; streamUrl?: string };
    plivo: { available: boolean; channel?: string; durationMs?: number | null; streamUrl?: string; reason?: string };
  };
};

export async function getCallRecordings(executionId: string): Promise<CallRecordingsResponse> {
  const { data } = await apiClient.get<CallRecordingsResponse>(
    `/bolna/call-records/${executionId}/recordings`
  );
  return data;
}

/** Fetch a proxied recording stream as an object URL (audio routes are JWT-protected). */
export async function fetchRecordingObjectUrl(streamUrl: string): Promise<string> {
  const path = streamUrl.replace(/^\/v1/, ""); // apiClient baseURL already includes /v1
  const res = await apiClient.get(path, { responseType: "blob" });
  return URL.createObjectURL(res.data as Blob);
}
```

> Verify the `apiClient` baseURL prefix (`/v1` vs `/api/v1`) and adjust the `.replace` so the path matches how other calls in this file are written (they use `/bolna/...` with no `/v1`). The backend stream URLs come back as `/v1/bolna/...`.

- [ ] **Step 3: Typecheck**

Run (in `uat.dharwin.frontend`): `npx tsc --noEmit`
Expected: no new type errors in `bolna.ts`.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/api/bolna.ts
git commit -m "feat(calling): API types for verification, quality, recordings"
```

---

## Task 11: `CallVerificationPanel` component

**Files:**
- Create: `uat.dharwin.frontend/app/(components)/(contentlayout)/communication/calling/_components/CallVerificationPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import type { CallRecord } from "@/shared/lib/api/bolna";

const yesNo = (v?: boolean | null) =>
  v === true ? "Yes" : v === false ? "No" : "—";

const interestLabel: Record<string, string> = {
  interested: "Interested",
  not_interested: "Not interested",
  withdrew: "Withdrew",
};

const outcomeLabel: Record<string, string> = {
  fully_confirmed: "Fully confirmed",
  partially_confirmed: "Partially confirmed",
  refused: "Refused",
  voicemail: "Voicemail",
  no_data: "No data",
};

export default function CallVerificationPanel({ record }: { record: CallRecord }) {
  const v = record.verification;
  const q = record.callQuality;
  const needsReview = q?.status === "needs_review";

  const rows: Array<[string, string]> = [
    ["Name confirmed", yesNo(v?.nameConfirmed)],
    ["Corrected name", v?.correctedName || "—"],
    ["Job confirmed", yesNo(v?.jobConfirmed)],
    ["Availability", v?.availability || "—"],
    ["Location", v?.currentLocation || "—"],
    ["Interest", v?.stillInterested ? interestLabel[v.stillInterested] : "—"],
    ["Outcome", v?.callOutcome ? outcomeLabel[v.callOutcome] : "—"],
  ];

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">Verification summary</span>
        {needsReview && (
          <span
            title={(q?.reasons || []).join(", ")}
            className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
          >
            Needs review
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={value === "Withdrew" ? "font-semibold text-red-600" : ""}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run (in `uat.dharwin.frontend`): `npx tsc --noEmit`
Expected: no errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add "app/(components)/(contentlayout)/communication/calling/_components/CallVerificationPanel.tsx"
git commit -m "feat(calling): verification summary panel"
```

---

## Task 12: `CallRecordings` component (both players)

**Files:**
- Create: `uat.dharwin.frontend/app/(components)/(contentlayout)/communication/calling/_components/CallRecordings.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useEffect, useState } from "react";
import { getCallRecordings, fetchRecordingObjectUrl } from "@/shared/lib/api/bolna";

export default function CallRecordings({ executionId }: { executionId: string }) {
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string[] = [];
    let cancelled = false;
    (async () => {
      try {
        const meta = await getCallRecordings(executionId);
        if (cancelled) return;
        if (meta.recordings.bolna.available && meta.recordings.bolna.streamUrl) {
          const u = await fetchRecordingObjectUrl(meta.recordings.bolna.streamUrl);
          if (!cancelled) { setAgentUrl(u); revoked.push(u); } else URL.revokeObjectURL(u);
        }
        if (meta.recordings.plivo.available && meta.recordings.plivo.streamUrl) {
          const u = await fetchRecordingObjectUrl(meta.recordings.plivo.streamUrl);
          if (!cancelled) { setFullUrl(u); revoked.push(u); } else URL.revokeObjectURL(u);
        }
      } catch {
        if (!cancelled) setError("Could not load recordings");
      }
    })();
    return () => {
      cancelled = true;
      revoked.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [executionId]);

  if (error) return <p className="text-xs text-muted-foreground">{error}</p>;

  return (
    <div className="space-y-2 text-sm">
      <div>
        <p className="mb-1 font-medium">Agent only (Bolna)</p>
        {agentUrl ? <audio controls src={agentUrl} className="w-full" /> : <p className="text-xs text-muted-foreground">—</p>}
      </div>
      <div>
        <p className="mb-1 font-medium">Full call — both voices (Plivo)</p>
        {fullUrl ? <audio controls src={fullUrl} className="w-full" /> : <p className="text-xs text-muted-foreground">—</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run (in `uat.dharwin.frontend`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "app/(components)/(contentlayout)/communication/calling/_components/CallRecordings.tsx"
git commit -m "feat(calling): dual-recording player (agent + full call)"
```

---

## Task 13: Render both components in the calling view

**Files:**
- Modify: `uat.dharwin.frontend/app/(components)/(contentlayout)/communication/calling/page.tsx`

- [ ] **Step 1: Read the page to find the per-call detail render site**

Run: open `app/(components)/(contentlayout)/communication/calling/page.tsx` and locate where a single call record's details/expanded row are rendered (search for `recordingUrl`, `transcript`, or where a selected/expanded `CallRecord` is shown).

- [ ] **Step 2: Import the components**

Add near the top of the file:

```tsx
import CallVerificationPanel from "./_components/CallVerificationPanel";
import CallRecordings from "./_components/CallRecordings";
```

- [ ] **Step 3: Render them in the call detail area**

Where the selected call's details are shown (the `record` of type `CallRecord` in scope), insert:

```tsx
<CallVerificationPanel record={record} />
{record.executionId ? <CallRecordings executionId={record.executionId} /> : null}
```

(Use the actual variable name for the call in that scope.)

- [ ] **Step 4: Typecheck + visual check**

Run (in `uat.dharwin.frontend`): `npx tsc --noEmit` → no errors.
Then run the app and open the Communication → Calling page; confirm a completed call shows the verification summary, the quality badge when flagged, and the two players.

- [ ] **Step 5: Commit**

```bash
git add "app/(components)/(contentlayout)/communication/calling/page.tsx"
git commit -m "feat(calling): surface verification, quality, and both recordings"
```

---

## Task 14: End-to-end validation (manual)

- [ ] **Step 1: Configure the 7 extractions in the Bolna dashboard** (per spec §3) on the candidate agent. One category "Candidate Verification", names + Expected Formats + prompts from the table.

- [ ] **Step 2: Place one real verification call** to a test number and complete the script.

- [ ] **Step 3: Verify ingest** — after the call, check the CallRecord:

Run: `node -e "import('./src/models/callRecord.model.js').then(async m=>{const r=await m.default.findOne().sort({createdAt:-1}).lean();console.log(JSON.stringify(r.verification,null,2));console.log(JSON.stringify(r.callQuality,null,2));process.exit(0)})"`
Expected: `verification` populated with the call's answers; `callQuality.status` reflects the call.

> If `verification` fields are null but `extractedData` is populated, compare the live `extracted_data` category/name casing against the constants in `candidateExtraction.js` and adjust (spec §8 item 3).

- [ ] **Step 4: Verify the calling view** shows the panel, badge, and recordings.

- [ ] **Step 5: Run backfill** for historical records via the sync endpoint and confirm older records gain `verification`.

---

## Self-Review

- **Spec coverage:** §3 fields → Tasks 1/14; §4.1 parser → Task 1; §4.2 schema → Task 4; §4.3 quality → Task 2; §4.4 withdraw → Task 7; §4.5 API surface → Tasks 5/6 (records already returned) + recordings (Task 10, endpoints pre-built); §4.6 backfill → Task 8; §5 frontend → Tasks 11-13; §6 data flow → Tasks 5/6; §8 spikes → Task 14 note. Covered.
- **Placeholder scan:** none — all steps contain real code/commands.
- **Type consistency:** `deriveCallInsights`, `parseCandidateExtraction`, `evaluateCallQuality` signatures match across tasks; field names (`nameConfirmed`, `stillInterested`, `callOutcome`, `fieldsPresent`, `minConfidence`, `callQuality.status/reasons`) consistent between util, schema (Task 4), and frontend types (Task 10).
