import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoleResponsibilities } from '../offer.service.js';

test('derives one responsibility per non-empty job description line', () => {
  const job = { jobDescription: 'Build dashboards\n\nOwn data quality\n- Mentor analysts' };
  assert.deepEqual(deriveRoleResponsibilities(job), [
    'Build dashboards',
    'Own data quality',
    'Mentor analysts',
  ]);
});

test('strips HTML tags from a rich-text job description', () => {
  const job = { jobDescription: '<ul><li>Design APIs</li><li>Write tests</li></ul>' };
  assert.deepEqual(deriveRoleResponsibilities(job), ['Design APIs', 'Write tests']);
});

test('falls back to skillRequirements when no description exists', () => {
  const job = { skillRequirements: [{ name: 'SQL' }, { name: 'Python' }] };
  assert.deepEqual(deriveRoleResponsibilities(job), [
    'Apply SQL in day-to-day responsibilities',
    'Apply Python in day-to-day responsibilities',
  ]);
});

test('caps the result at 12 entries to avoid bullet explosion', () => {
  const job = { jobDescription: Array.from({ length: 30 }, (_, i) => `Line ${i}`).join('\n') };
  assert.equal(deriveRoleResponsibilities(job).length, 12);
});

test('returns an empty array when the job has neither', () => {
  assert.deepEqual(deriveRoleResponsibilities({}), []);
  assert.deepEqual(deriveRoleResponsibilities(null), []);
});
