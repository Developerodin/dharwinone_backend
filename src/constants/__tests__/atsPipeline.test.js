import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_TRANSITIONS,
  APPLICATION_STATUSES,
  CANDIDATE_STATUS_MAP,
  INTERVIEW_STATUSES,
  INTERVIEW_RESULTS,
  OFFER_STATUSES,
  PLACEMENT_STATUSES,
  PRE_BOARDING_STATUSES,
  isAllowedTransition,
} from '../atsPipeline.js';

test('atsPipeline exposes expected status sets', () => {
  assert.deepEqual(APPLICATION_STATUSES, [
    'Applied',
    'Screening',
    'Interview',
    'Shortlisted',
    'Offered',
    'Hired',
    'Rejected',
  ]);
  assert.deepEqual(INTERVIEW_STATUSES, ['scheduled', 'ended', 'cancelled']);
  assert.deepEqual(INTERVIEW_RESULTS, ['pending', 'selected', 'rejected']);
  assert.deepEqual(OFFER_STATUSES, ['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected']);
  assert.deepEqual(PLACEMENT_STATUSES, ['Pending', 'Onboarding', 'Joined', 'Deferred', 'Cancelled']);
  assert.deepEqual(PRE_BOARDING_STATUSES, ['Pending', 'In Progress', 'Completed']);
});

test('atsPipeline transition tables include core guardrails', () => {
  // Application pipeline is strict forward-only — no stage skipping.
  assert.equal(isAllowedTransition('application', 'Applied', 'Screening'), true);
  assert.equal(isAllowedTransition('application', 'Applied', 'Interview'), false);
  assert.equal(isAllowedTransition('application', 'Applied', 'Hired'), false);
  assert.equal(isAllowedTransition('application', 'Hired', 'Applied'), false);
  assert.equal(isAllowedTransition('offer', 'Draft', 'Accepted'), false);
  assert.equal(isAllowedTransition('offer', 'Sent', 'Accepted'), true);
  assert.equal(isAllowedTransition('placement', 'Joined', 'Deferred'), true);
  assert.equal(isAllowedTransition('placement', 'Joined', 'Pending'), false);
});

test('atsPipeline transition maps are aligned with status lists', () => {
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS.application), APPLICATION_STATUSES);
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS.interviewResult), INTERVIEW_RESULTS);
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS.offer), OFFER_STATUSES);
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS.placement), PLACEMENT_STATUSES);
});

test('candidate status map has complete coverage', () => {
  assert.deepEqual(Object.keys(CANDIDATE_STATUS_MAP.application), APPLICATION_STATUSES);
  assert.deepEqual(Object.keys(CANDIDATE_STATUS_MAP.interviewResult), INTERVIEW_RESULTS);
  assert.deepEqual(Object.keys(CANDIDATE_STATUS_MAP.offer), OFFER_STATUSES);
  assert.deepEqual(Object.keys(CANDIDATE_STATUS_MAP.placement), PLACEMENT_STATUSES);
});
