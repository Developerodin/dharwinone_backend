import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeCandidateApplication } from '../candidateApplication.serializer.js';

test('serializer surfaces internal pre-boarding as candidate-visible "Offer"', () => {
  const out = serializeCandidateApplication({ status: 'Hired', _id: 'a1' }, { placementStatus: 'Pending' });
  assert.equal(out.candidateVisibleStatus, 'Offer');
  assert.equal(out.status, 'Hired');
});

test('serializer falls back to the raw application status', () => {
  const out = serializeCandidateApplication({ status: 'Interview', _id: 'a2' });
  assert.equal(out.candidateVisibleStatus, 'Interview');
});
