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
  JOB_TYPES,
  COMPENSATION_SOURCES,
  compensationTypeForJobType,
  resolveCandidateVisibleStatus,
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

test('JOB_TYPES maps each job type to a compensation type', () => {
  const byValue = Object.fromEntries(JOB_TYPES.map((t) => [t.value, t]));
  assert.equal(byValue.FT_40.compensationType, 'paid');
  assert.equal(byValue.PT_25.compensationType, 'paid');
  assert.equal(byValue.INTERN_UNPAID.compensationType, 'unpaid');
  assert.deepEqual(
    JOB_TYPES.map((t) => t.value),
    ['FT_40', 'PT_25', 'INTERN_UNPAID']
  );
});

test('compensationTypeForJobType derives compensation, defaults to paid', () => {
  assert.equal(compensationTypeForJobType('FT_40'), 'paid');
  assert.equal(compensationTypeForJobType('PT_25'), 'paid');
  assert.equal(compensationTypeForJobType('INTERN_UNPAID'), 'unpaid');
  assert.equal(compensationTypeForJobType(undefined), 'paid');
  assert.equal(compensationTypeForJobType('NONSENSE'), 'paid');
});

test('COMPENSATION_SOURCES includes the derived seam value', () => {
  assert.ok(COMPENSATION_SOURCES.includes('jobTypeDerived'));
});

test('placement Pending maps to candidate-visible "Offer"', () => {
  assert.equal(CANDIDATE_STATUS_MAP.placement.Pending, 'Offer');
});

test('resolveCandidateVisibleStatus hides internal pre-boarding as "Offer"', () => {
  assert.equal(
    resolveCandidateVisibleStatus({ applicationStatus: 'Hired', placementStatus: 'Pending' }),
    'Offer'
  );
});

test('resolveCandidateVisibleStatus falls back to the raw application status', () => {
  assert.equal(resolveCandidateVisibleStatus({ applicationStatus: 'Interview' }), 'Interview');
  assert.equal(
    resolveCandidateVisibleStatus({ applicationStatus: 'Hired', placementStatus: 'Joined' }),
    'Hired'
  );
});
