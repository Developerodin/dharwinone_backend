import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Offer from '../offer.model.js';

test('Offer.compensationType defaults to paid', () => {
  assert.equal(new Offer().compensationType, 'paid');
});

test('Offer.compensationSource defaults to jobTypeDerived', () => {
  assert.equal(new Offer().compensationSource, 'jobTypeDerived');
});

test('Offer.compensationType rejects values outside the enum', () => {
  const offer = new Offer({
    offerCode: 'OFF-TEST-0001',
    jobApplication: new mongoose.Types.ObjectId(),
    job: new mongoose.Types.ObjectId(),
    candidate: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    compensationType: 'salaried',
  });
  const err = offer.validateSync();
  assert.ok(err?.errors?.compensationType, 'expected compensationType error');
});

test('Offer.compensationType accepts unpaid', () => {
  const offer = new Offer({
    offerCode: 'OFF-TEST-0002',
    jobApplication: new mongoose.Types.ObjectId(),
    job: new mongoose.Types.ObjectId(),
    candidate: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    compensationType: 'unpaid',
  });
  const err = offer.validateSync();
  assert.ok(!err?.errors?.compensationType, 'unpaid should be valid');
});
