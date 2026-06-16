import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateExtraction, evaluateCallQuality, deriveCallInsights, readBolnaCallSummary } from '../candidateExtraction.js';

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

// --- Task 2: evaluateCallQuality ---

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

test('flags empty extraction when CV category present but fields empty', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: Hi\nuser: yes',
    verification: { fieldsPresent: 0, minConfidence: null },
    extractionPresent: true,
    structuredCategoryPresent: true,
  });
  assert.equal(q.status, 'needs_review');
  assert.ok(q.reasons.includes('empty_extraction'));
});

test('flags structured_extraction_not_configured when only General Call Summary', () => {
  const q = evaluateCallQuality({
    status: 'completed',
    transcript: 'assistant: Hi\nuser: yes',
    verification: { fieldsPresent: 0, minConfidence: null },
    extractionPresent: true,
    structuredCategoryPresent: false,
  });
  assert.equal(q.status, 'needs_review');
  assert.ok(q.reasons.includes('structured_extraction_not_configured'));
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

// --- Task 3: deriveCallInsights ---

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

test('normalizes hyphenated enum values', () => {
  const r = parseCandidateExtraction({
    'Candidate Verification': { 'Still Interested': { objective: 'not-interested', confidence: 0.9 } },
  });
  assert.equal(r.stillInterested, 'not_interested');
});

test('readBolnaCallSummary reads General Call Summary subjective', () => {
  const s = readBolnaCallSummary({
    General: {
      'Call Summary': {
        objective: null,
        confidence: 0.95,
        subjective: 'Applicant confirmed name and role.',
      },
    },
  });
  assert.equal(s?.subjective, 'Applicant confirmed name and role.');
  assert.equal(s?.confidence, 0.95);
});

test('parseCandidateExtraction falls back to subjective for text fields', () => {
  const r = parseCandidateExtraction({
    'Candidate Verification': {
      Availability: { objective: null, subjective: 'in two weeks', confidence: 0.9 },
      'Current Location': { objective: null, subjective: 'Jaipur, Rajasthan', confidence: 0.88 },
    },
  });
  assert.equal(r.availability, 'in two weeks');
  assert.equal(r.currentLocation, 'Jaipur, Rajasthan');
});
