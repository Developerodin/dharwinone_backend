import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { buildConclusionRecipients } from '../meeting.service.js';

/**
 * `Meeting.recruiter.id` and `Meeting.agents[].id` are free-form Strings — the model
 * comment allows external/mock ids like "1". Passing one to notify() reaches
 * User.findById and throws a CastError, which the dispatcher then books as a delivery
 * failure and retries three times before giving up.
 */
const validId = new mongoose.Types.ObjectId().toString();

test('a non-ObjectId recruiter id is dropped, its email is kept', () => {
  const out = buildConclusionRecipients({
    recruiter: { id: '1', email: 'Recruiter@Example.com' },
    agents: [],
    createdBy: null,
  });
  assert.deepEqual(out, [{ kind: 'email', email: 'recruiter@example.com' }]);
});

test('a valid recruiter id produces both an email and an in-app recipient', () => {
  const out = buildConclusionRecipients({
    recruiter: { id: validId, email: 'r@example.com' },
    agents: [],
    createdBy: null,
  });
  assert.deepEqual(out, [
    { kind: 'email', email: 'r@example.com' },
    { kind: 'inApp', userId: validId },
  ]);
});

test('duplicate agent emails and ids collapse', () => {
  const out = buildConclusionRecipients({
    recruiter: { id: validId, email: 'dup@example.com' },
    agents: [{ id: validId, email: 'dup@example.com' }],
    createdBy: validId,
  });
  assert.equal(out.filter((r) => r.kind === 'email').length, 1);
  assert.equal(out.filter((r) => r.kind === 'inApp').length, 1);
});

test('createdBy is in-app only and is dropped when it is not an ObjectId', () => {
  const out = buildConclusionRecipients({ recruiter: {}, agents: [], createdBy: 'legacy' });
  assert.deepEqual(out, []);
});
