import test from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePreBoardingStatus,
  snapshotPlacementForPreboardingGate,
  isPreboardingGateSatisfied,
} from '../placement.service.js';

test('derivePreBoardingStatus returns Completed when BGV is Completed and no checklist', () => {
  const status = derivePreBoardingStatus({
    preBoardingTasks: [],
    backgroundVerification: { status: 'Completed' },
  });
  assert.equal(status, 'Completed');
});

test('derivePreBoardingStatus returns Completed when BGV is Verified', () => {
  const status = derivePreBoardingStatus({
    backgroundVerification: { status: 'Verified' },
  });
  assert.equal(status, 'Completed');
});

test('derivePreBoardingStatus prefers incomplete required checklist over BGV', () => {
  const status = derivePreBoardingStatus({
    preBoardingTasks: [{ title: 'Docs', required: true, done: false }],
    backgroundVerification: { status: 'Completed' },
  });
  assert.equal(status, 'Pending');
});

test('snapshotPlacementForPreboardingGate merges BGV from PATCH before gate check', () => {
  const placement = {
    preBoardingStatus: 'Pending',
    preBoardingTasks: [],
    backgroundVerification: { status: 'Pending' },
  };
  const updateBody = {
    status: 'Onboarding',
    backgroundVerification: { status: 'Completed' },
  };
  const snap = snapshotPlacementForPreboardingGate(placement, updateBody);
  assert.equal(snap.preBoardingStatus, 'Completed');
  assert.equal(isPreboardingGateSatisfied(snap), true);
});
