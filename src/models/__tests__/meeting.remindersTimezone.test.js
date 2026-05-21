import test from 'node:test';
import assert from 'node:assert/strict';
import Meeting from '../meeting.model.js';

test('timezone defaults to UTC', () => {
  assert.equal(Meeting.schema.path('timezone').defaultValue, 'UTC');
});

test('agents is an array of {id,name,email}', () => {
  const agents = Meeting.schema.path('agents');
  assert.ok(agents);
  assert.equal(agents.instance, 'Array');
});

test('new dedup + completion timestamp fields exist and default null', () => {
  for (const f of ['conclusionNotifiedAt', 'interviewCompletedAt']) {
    const path = Meeting.schema.path(f);
    assert.ok(path, `${f} missing`);
    assert.equal(path.instance, 'Date');
    assert.equal(path.defaultValue, null);
  }
});

test('reminderRetry and conclusionRetry sub-documents exist with defaults', () => {
  for (const group of ['reminderRetry', 'conclusionRetry']) {
    assert.equal(Meeting.schema.path(`${group}.attempts`).defaultValue, 0);
    assert.equal(Meeting.schema.path(`${group}.claimedAt`).defaultValue, null);
    assert.equal(Meeting.schema.path(`${group}.lastError`).defaultValue, null);
    assert.equal(Meeting.schema.path(`${group}.lastErrorAt`).defaultValue, null);
    assert.equal(Meeting.schema.path(`${group}.failedAt`).defaultValue, null);
    const cat = Meeting.schema.path(`${group}.lastErrorCategory`);
    assert.ok(cat, `${group}.lastErrorCategory missing`);
    assert.deepEqual(cat.enumValues, [
      'timeout',
      'invalid_recipient',
      'template_failure',
      'provider_failure',
      'unknown',
    ]);
  }
});
