/**
 * Batch B — PATCH /call-records/:id annotation validation guards.
 * Run: node --test src/validations/__tests__/patchCallRecord.validation.test.js
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

let patchCallRecord;

before(async () => {
  ({ patchCallRecord } = await import('../bolna.validation.js'));
});

const VALID_ID = '507f1f77bcf86cd799439011';

function check(part, value) {
  return patchCallRecord[part].validate(value);
}

test('accepts notes + valid tags + relatedTo', () => {
  const { error } = check('body', {
    notes: 'Called, left voicemail',
    tags: ['sales', 'follow_up'],
    relatedTo: { entityType: 'lead', entityId: VALID_ID },
  });
  assert.equal(error, undefined);
});

test('rejects an unknown tag', () => {
  const { error } = check('body', { tags: ['sales', 'not_a_tag'] });
  assert.ok(error);
});

test('rejects an unknown entityType', () => {
  const { error } = check('body', { relatedTo: { entityType: 'spaceship', entityId: VALID_ID } });
  assert.ok(error);
});

test('rejects a non-ObjectId entityId', () => {
  const { error } = check('body', { relatedTo: { entityType: 'lead', entityId: '123' } });
  assert.ok(error);
});

test('rejects an empty body (min 1 key)', () => {
  const { error } = check('body', {});
  assert.ok(error);
});

test('allows clearing relatedTo with nulls', () => {
  const { error } = check('body', { relatedTo: { entityType: null, entityId: null } });
  assert.equal(error, undefined);
});

test('rejects a non-ObjectId :id param', () => {
  const { error } = check('params', { id: 'nope' });
  assert.ok(error);
});
