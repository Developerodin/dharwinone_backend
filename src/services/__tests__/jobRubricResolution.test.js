import test from 'node:test';
import assert from 'node:assert/strict';
import { pickJobAssignment, pickMostSpecificTemplate } from '../rubricTemplate.service.js';

const TPL = '507f1f77bcf86cd799439011';
const criteria = [{ key: 'a', label: 'A', weight: 100, scaleMin: 1, scaleMax: 5 }];

test('a job row matching the round type wins over the job default', () => {
  const rows = [
    { roundType: null, templateId: TPL },
    { roundType: 'technical', criteria },
  ];
  assert.equal(pickJobAssignment(rows, 'technical').criteria, criteria);
});

test('the job default covers a round type with no row of its own', () => {
  const rows = [
    { roundType: null, templateId: TPL },
    { roundType: 'technical', criteria },
  ];
  assert.equal(pickJobAssignment(rows, 'hr').templateId, TPL);
});

test('a round with no type uses the job default', () => {
  const rows = [
    { roundType: null, templateId: TPL },
    { roundType: 'technical', criteria },
  ];
  assert.equal(pickJobAssignment(rows, null).templateId, TPL);
});

test('a round with no type and no job default row falls through', () => {
  // The job has opinions, but none covers an untyped round (audit J7).
  assert.equal(pickJobAssignment([{ roundType: 'technical', criteria }], null), null);
});

test('a job with no assignments falls through', () => {
  assert.equal(pickJobAssignment([], 'technical'), null);
  assert.equal(pickJobAssignment(null, 'technical'), null);
  assert.equal(pickJobAssignment(undefined, null), null);
});

test('a round type the job has not named falls through when there is no job default', () => {
  assert.equal(pickJobAssignment([{ roundType: 'hr', criteria }], 'technical'), null);
});

test('a template pinned to a job is NO LONGER matched', () => {
  // J1: job targeting moved to the job side. A stale appliesTo.jobId must not resolve, or
  // both directions would be live and could disagree.
  const templates = [{ name: 'stale job pin', appliesTo: { jobId: 'job1', roundType: null } }];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'technical' }), null);
});

test('round-type and default templates still resolve', () => {
  const templates = [
    { name: 'house default', appliesTo: { jobId: null, roundType: null }, isDefault: true },
    { name: 'hr policy', appliesTo: { jobId: null, roundType: 'hr' } },
  ];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'hr' }).name, 'hr policy');
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'final' }).name, 'house default');
});
