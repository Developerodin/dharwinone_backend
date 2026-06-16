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
