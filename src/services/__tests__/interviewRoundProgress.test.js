import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRoundProgress, roundProgressLabel } from '../interviewRoundProgress.service.js';

const plan = [
  { key: 'round_1', label: 'Screening', roundType: 'screening' },
  { key: 'round_2', label: 'Technical 1', roundType: 'technical' },
  { key: 'round_3', label: 'Technical 2', roundType: 'technical' },
];

const meeting = (planKey, interviewResult, status = 'ended') => ({
  _id: `m-${planKey}-${interviewResult}`,
  round: { planKey },
  status,
  interviewResult,
});

test('no plan means no gate', () => {
  const p = computeRoundProgress({ planRounds: [], meetings: [meeting('x', 'selected')] });
  assert.equal(p.hasPlan, false);
  assert.equal(p.isComplete, false);
  assert.equal(p.nextRound, null);
});

test('called with nothing at all is still no plan', () => {
  const p = computeRoundProgress();
  assert.equal(p.hasPlan, false);
  assert.equal(p.total, 0);
});

test('nextRound is the first unscheduled row', () => {
  const p = computeRoundProgress({ planRounds: plan, meetings: [meeting('round_1', 'selected')] });
  assert.equal(p.nextRound.key, 'round_2');
  assert.equal(p.passedCount, 1);
  assert.equal(p.isComplete, false);
});

test('all rows passed is complete, with no next round', () => {
  const p = computeRoundProgress({ planRounds: plan, meetings: plan.map((r) => meeting(r.key, 'selected')) });
  assert.equal(p.isComplete, true);
  assert.equal(p.nextRound, null);
  assert.equal(p.passedCount, 3);
});

test('a pending round is held but not passed, and blocks completion', () => {
  const p = computeRoundProgress({
    planRounds: plan,
    meetings: [meeting('round_1', 'selected'), meeting('round_2', 'pending'), meeting('round_3', 'selected')],
  });
  assert.equal(p.isComplete, false);
  assert.equal(p.heldCount, 3);
  assert.equal(p.passedCount, 2);
  assert.equal(p.nextRound, null, 'every row has a meeting, so there is nothing to schedule');
});

test('a rejection anywhere stops the process', () => {
  const p = computeRoundProgress({
    planRounds: plan,
    meetings: [meeting('round_1', 'selected'), meeting('round_2', 'rejected')],
  });
  assert.equal(p.rejectedAt.key, 'round_2');
  assert.equal(p.rejectedAt.index, 2);
  assert.equal(p.isComplete, false);
  assert.equal(p.nextRound, null, 'a rejected candidate has no next round');
});

test('a cancelled meeting frees its row', () => {
  const p = computeRoundProgress({
    planRounds: plan,
    meetings: [meeting('round_1', 'selected'), meeting('round_2', 'rejected', 'cancelled')],
  });
  assert.equal(p.rejectedAt, null);
  assert.equal(p.nextRound.key, 'round_2');
});

test('a meeting on no plan row is off-plan and does not block completion', () => {
  const p = computeRoundProgress({
    planRounds: plan,
    meetings: [...plan.map((r) => meeting(r.key, 'selected')), meeting(null, 'pending')],
  });
  assert.equal(p.offPlanCount, 1);
  assert.equal(p.isComplete, true);
});

test('two meetings on one row: the later live one wins', () => {
  const p = computeRoundProgress({
    planRounds: plan,
    meetings: [meeting('round_1', 'rejected', 'cancelled'), meeting('round_1', 'selected')],
  });
  assert.equal(p.rows[0].state, 'passed');
  assert.equal(p.rejectedAt, null);
});

test('labels read correctly in every state', () => {
  assert.equal(roundProgressLabel(computeRoundProgress({ planRounds: [], meetings: [] })), '');
  assert.match(
    roundProgressLabel(computeRoundProgress({ planRounds: plan, meetings: [meeting('round_1', 'selected')] })),
    /1 of 3/
  );
  assert.match(
    roundProgressLabel(
      computeRoundProgress({ planRounds: plan, meetings: plan.map((r) => meeting(r.key, 'selected')) })
    ),
    /All 3 rounds passed/i
  );
  assert.match(
    roundProgressLabel(computeRoundProgress({ planRounds: plan, meetings: [meeting('round_1', 'rejected')] })),
    /Rejected at Screening/i
  );
});
