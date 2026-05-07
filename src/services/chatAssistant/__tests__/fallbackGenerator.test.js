// Tests for the contextual empty-state generator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFallback, isEmptyResult, moduleForKind } from '../fallbackGenerator.js';

test('buildFallback emits FallbackBlock + markdown twin with query', () => {
  const { block, markdown } = buildFallback({
    module: 'employees',
    queryArg: 'Akash',
  });
  assert.equal(block.type, 'fallback');
  assert.equal(block.kind, 'employees');
  assert.equal(block.query, 'Akash');
  assert.match(block.title, /Akash/);
  assert.match(block.title, /employee/);
  assert.match(markdown, /Akash/);
  assert.match(markdown, /Try next/);
});

test('buildFallback without queryArg uses "filters" wording', () => {
  const { block, markdown } = buildFallback({ module: 'jobs' });
  assert.match(block.title, /filters/);
  assert.equal(block.query, undefined);
  assert.match(markdown, /Try next/);
});

test('buildFallback surfaces filters + permissions + archived as reasons', () => {
  const { block } = buildFallback({
    module: 'employees',
    queryArg: 'Saad',
    filters: { role: 'Agent', department: 'Sales', status: 'active' },
    permissions: { denied: true, scope: 'your team' },
    archived: { exists: true, count: 3 },
    similarMatches: ['Saad Khan', 'Saadiq', 'Saadia', 'Saadat'],
  });
  const reasons = block.reasons.join(' | ');
  assert.match(reasons, /role=Agent/);
  assert.match(reasons, /department=Sales/);
  assert.match(reasons, /status=active/);
  assert.match(reasons, /your team/);
  assert.match(reasons, /archived/);
  assert.match(reasons, /Saad Khan/);
  // Top-3 fuzzy slice is enforced — 4th name should not surface
  assert.equal(reasons.includes('Saadat'), false);
});

test('buildFallback per-module suggestions differ', () => {
  const empSuggestions = buildFallback({ module: 'employees', queryArg: 'X' }).block.suggestions;
  const jobSuggestions = buildFallback({ module: 'jobs' }).block.suggestions;
  const candSuggestions = buildFallback({ module: 'candidates' }).block.suggestions;
  assert.match(empSuggestions.join(' '), /employee ID/);
  assert.match(jobSuggestions.join(' '), /open jobs/);
  assert.match(candSuggestions.join(' '), /email or phone/);
});

test('buildFallback for unknown module falls back to default suggestions', () => {
  const { block } = buildFallback({ module: 'spaceships', queryArg: 'Falcon' });
  assert.match(block.suggestions.join(' '), /broader query/);
});

test('isEmptyResult flags notFound + empty records + total=0', () => {
  assert.equal(isEmptyResult(null), true);
  assert.equal(isEmptyResult({ notFound: true }), true);
  assert.equal(isEmptyResult({ records: [] }), true);
  assert.equal(isEmptyResult({ total: 0 }), true);
});

test('isEmptyResult does NOT flag needsTimeWindow as empty', () => {
  assert.equal(isEmptyResult({ needsTimeWindow: true }), false);
});

test('isEmptyResult does NOT flag populated payloads', () => {
  assert.equal(isEmptyResult({ records: [{ id: 1 }], total: 1 }), false);
  assert.equal(isEmptyResult({ total: 7 }), false);
});

test('moduleForKind maps known kinds to module slugs', () => {
  assert.equal(moduleForKind('fetch_employees'), 'employees');
  assert.equal(moduleForKind('fetch_people'), 'employees');
  assert.equal(moduleForKind('attendance_summary_day'), 'attendance');
  assert.equal(moduleForKind('attendance_summary_range'), 'attendance');
  assert.equal(moduleForKind('fetch_leave_requests'), 'leave');
  assert.equal(moduleForKind('fetch_jobs'), 'jobs');
  assert.equal(moduleForKind('fetch_candidates'), 'candidates');
  assert.equal(moduleForKind('fetch_placements'), 'onboarding');
});

test('moduleForKind echoes unknown kinds verbatim', () => {
  assert.equal(moduleForKind('fetch_widgets'), 'fetch_widgets');
  assert.equal(moduleForKind(''), 'unknown');
});
