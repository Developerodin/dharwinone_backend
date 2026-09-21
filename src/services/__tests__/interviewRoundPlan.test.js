import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLANNED_ROUNDS,
  roundPlanError,
  nextPlanKey,
} from '../../constants/interviewRoundPlan.js';

const goodCriteria = [
  { key: 'technical', label: 'Technical', weight: 60, scaleMin: 1, scaleMax: 5 },
  { key: 'comms', label: 'Communication', weight: 40, scaleMin: 1, scaleMax: 5 },
];

const row = (over = {}) => ({
  key: 'r1',
  label: 'Screening',
  roundType: 'screening',
  templateId: '507f1f77bcf86cd799439011',
  criteria: null,
  ...over,
});

test('no plan is valid', () => {
  assert.equal(roundPlanError(null), null);
  assert.equal(roundPlanError(undefined), null);
  assert.equal(roundPlanError([]), null);
});

test('a non-array is rejected', () => {
  assert.match(roundPlanError({}), /must be a list/i);
});

test('two rounds of the same type are ALLOWED', () => {
  const plan = [
    row({ key: 'r1', label: 'Technical 1', roundType: 'technical' }),
    row({ key: 'r2', label: 'Technical 2', roundType: 'technical', templateId: null, criteria: goodCriteria }),
  ];
  assert.equal(roundPlanError(plan), null);
});

test('two Other rows with different templateIds save (type is not identity)', () => {
  const plan = [
    row({ key: 'r1', label: 'Other v1', roundType: 'other', templateId: '507f1f77bcf86cd799439011' }),
    row({ key: 'r2', label: 'Other v2', roundType: 'other', templateId: '507f1f77bcf86cd799439012' }),
  ];
  assert.equal(roundPlanError(plan), null);
});

test('duplicate keys are rejected and the message names the key', () => {
  const plan = [row({ key: 'dup' }), row({ key: 'dup', label: 'HR', roundType: 'hr' })];
  assert.match(roundPlanError(plan), /dup/);
});

test('a missing key is rejected', () => {
  assert.match(roundPlanError([row({ key: '' })]), /needs an internal key/i);
});

test('a malformed key is rejected', () => {
  assert.match(roundPlanError([row({ key: 'Has Spaces' })]), /internal key/i);
});

test('a missing label is rejected and the message names the position', () => {
  assert.match(roundPlanError([row({ label: '   ' })]), /Round 1/);
});

test('an unknown round type is rejected', () => {
  assert.match(roundPlanError([row({ roundType: 'vibes' })]), /not an interview round type/i);
});

test('a null round type is allowed', () => {
  assert.equal(roundPlanError([row({ roundType: null })]), null);
});

test('both a template and criteria is rejected', () => {
  assert.match(roundPlanError([row({ criteria: goodCriteria })]), /not both, and not neither/i);
});

test('neither a template nor criteria is rejected', () => {
  assert.match(roundPlanError([row({ templateId: null, criteria: null })]), /not both, and not neither/i);
});

test('bad criteria weights are rejected and the message names the round', () => {
  const bad = [{ key: 'a', label: 'A', weight: 30, scaleMin: 1, scaleMax: 5 }];
  const msg = roundPlanError([row({ label: 'Technical 2', templateId: null, criteria: bad })]);
  assert.match(msg, /Technical 2/);
  assert.match(msg, /add up to 100/i);
});

test('too many rounds is rejected', () => {
  const plan = Array.from({ length: MAX_PLANNED_ROUNDS + 1 }, (_, i) =>
    row({ key: `r${i}`, label: `Round ${i}` })
  );
  assert.match(roundPlanError(plan), new RegExp(String(MAX_PLANNED_ROUNDS)));
});

test('nextPlanKey never collides with a taken key', () => {
  const taken = new Set(['round_1', 'round_2']);
  const key = nextPlanKey(taken);
  assert.equal(taken.has(key), false);
  assert.match(key, /^round_\d+$/);
});
