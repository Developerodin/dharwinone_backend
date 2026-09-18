import test from 'node:test';
import assert from 'node:assert/strict';
import { pickMostSpecificTemplate } from '../rubricTemplate.service.js';

const tpl = (name, jobId, roundType, isDefault = false) => ({
  name,
  appliesTo: { jobId, roundType },
  isDefault,
});

const JOB = 'job1';
const OTHER_JOB = 'job2';

test('a round-type template wins over job-pinned templates (J1)', () => {
  const templates = [
    tpl('default', null, null, true),
    tpl('round only', null, 'technical'),
    tpl('job only', JOB, null),
    tpl('exact job pin', JOB, 'technical'),
  ];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'technical' }).name, 'round only');
});

test('a job-only template is ignored; round-type template wins (J1)', () => {
  const templates = [tpl('round only', null, 'technical'), tpl('job only', JOB, null)];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'technical' }).name, 'round only');
});

test('a round-type template beats the default template', () => {
  const templates = [tpl('default', null, null, true), tpl('round only', null, 'hr')];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'hr' }).name, 'round only');
});

test('the default template is used when nothing else matches', () => {
  const templates = [tpl('default', null, null, true), tpl('other job', OTHER_JOB, null)];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'final' }).name, 'default');
});

test('a job-only pin is not matched, even when the job id would have matched (J1)', () => {
  const templates = [tpl('job pin', JOB, null)];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'technical' }), null);
});

test('a template for a different round type never matches', () => {
  const templates = [tpl('hr round', null, 'hr')];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'technical' }), null);
});

test('an untargeted template that is not the default never auto-applies', () => {
  const templates = [tpl('unused', null, null, false)];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: 'technical' }), null);
});

test('a round with no type uses the default, not a job-pinned template (J1)', () => {
  const templates = [tpl('default', null, null, true), tpl('job only', JOB, null), tpl('tech', null, 'technical')];
  assert.equal(pickMostSpecificTemplate(templates, { roundType: null }).name, 'default');
});

test('an empty template list resolves to null', () => {
  assert.equal(pickMostSpecificTemplate([], { roundType: 'technical' }), null);
  assert.equal(pickMostSpecificTemplate(null, { roundType: 'technical' }), null);
});
